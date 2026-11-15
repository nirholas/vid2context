# Providers and rungs

Every rung vid2context can use, the env var that enables it, its tier, and what the free tier allows. All keys are optional: with none set, vid2context uses YouTube captions plus the keyless speech-to-text and LLM lanes.

Tier order under the default `free` policy: **local** (this machine, private) then **free** (hosted free tier, your key) then **keyless** (hosted, no account) then **paid** (only when its key is set). See [ARCHITECTURE.md](ARCHITECTURE.md#the-rung-chain) for policies and cooldowns.

Check what is enabled right now: `GET /api/v1/health` (server) lists every provider and rung with `enabled` and the env vars it `requires`, never their values.

Limits below come from the providers' published free tiers or from live checks; the date says when. Free tiers change often; when a rung starts failing with `auth`, `rate-limited` or `not-found`, check the provider's console and override the model with env.

## Sources and captions

| Provider id | What | Enabled by | Notes |
|---|---|---|---|
| `youtube` | YouTube URLs and ids: metadata, description chapters | always | innertube player API, no key: ANDROID, then IOS (`YOUTUBE_CLIENTS`, `YOUTUBE_ANDROID_VERSION`, `YOUTUBE_IOS_VERSION`). Datacenter IPs may be blocked (`blocked` error); run locally or behind a tunnel, or set `YOUTUBE_PROXY` (HTTP(S) proxies for YouTube hosts only, comma-separated, rotated per request; Node). When the player is blocked, metadata comes from `next` and oEmbed instead. See [guides/youtube.md](guides/youtube.md#captions-and-blocks). |
| `youtube` (comments) | top or newest comments with pinned and creator flags, likes, approximate dates and a few replies per thread | always, when comments are requested | innertube `next` with the WEB client, no key. `YOUTUBE_COMMENT_REPLIES` (default 5, 0 turns replies off), `YOUTUBE_COMMENTS_SORT` (`top` or `newest`), `YOUTUBE_WEB_VERSION` (WEB client version, shared with metadata and browse). See [guides/youtube.md](guides/youtube.md#comments). |
| `youtube` (lists) | playlists, channels (all uploads or a tab: videos, shorts, streams, playlists, featured) and `ytsearch:` searches expanded to video refs, plus list metadata | always, for `listItems` and list refs | innertube `browse`, `search` and `navigation/resolve_url` with the WEB client, no key. Search defaults to 20 results, max 200. `YOUTUBE_WEB_VERSION` (shared with comments). See [guides/youtube.md](guides/youtube.md#playlists-channels-and-search). |
| `youtube-captions` | creator captions, auto-captions, YouTube translation (`tlang`); srv3, srv1, json3 and WebVTT payloads | always | Same clients and fallback as `youtube`. Backoff on 429 and 5xx; after a block, YouTube calls pause for `YOUTUBE_BLOCK_COOLDOWN_SEC` (default 600). Optional `YOUTUBE_COOKIE`, `YOUTUBE_PO_TOKEN`, `YOUTUBE_VISITOR_DATA`. A GCP VM was blocked on timedtext (HTTP 429) on 2026-11-14 while the player API still answered. See [guides/youtube.md](guides/youtube.md#captions-and-blocks). |
| `media-file` | local files and `file://` URLs (Node only) | always | With ffmpeg: title, artist, date, duration, container chapters and audio language from ffprobe; video files have their audio extracted as 16 kHz mono 32 kbps mp3 (about 14 MB per hour); audio files up to 25 MB in a format speech-to-text accepts pass through untouched. Without ffmpeg: filesystem metadata, audio files as raw bytes, video files fail with an install hint. ffmpeg comes from `FFMPEG_PATH`/`FFPROBE_PATH`, `PATH`, `~/.local/bin` or a managed download (`VID2CONTEXT_FFMPEG_DOWNLOAD=0` disables). See [guides/local-files.md](guides/local-files.md). |
| `media-file-captions` | subtitles that come with a local file: sidecars (`talk.srt`, `talk.en.vtt`, `talk.pt-BR.srt`) and embedded text subtitle streams (mkv, mp4 `mov_text`) as `creator-captions` (Node only) | always | Language from the file name or stream tag. Sidecars need nothing; embedded streams need ffmpeg. Forced tracks are never used as the transcript. When a language is asked for and only other languages exist, speech-to-text runs instead. |
| `media-url` | direct http(s) links to media files (`.mp3 .m4a .aac .wav .flac .ogg .opus .mp4 .m4v .webm .mov .mkv`): file name as title, size and type from `HEAD` (or a one-byte ranged `GET`), audio for speech-to-text (Node, Workers, browser) | always | Downloads through `ctx.fetch`, capped by `VID2CONTEXT_MAX_MEDIA_MB` (default 200). On Node, video URLs go to `media-stream` for ffmpeg extraction; on Workers and in the browser only video files up to 25 MB are accepted. Verified live 2026-11-14 with a NASA mp3 on Wikimedia through the keyless OVH rung. |
| `media-stream` | HLS (`.m3u8`) and DASH (`.mpd`) URLs, and the audio of direct video URLs (Node only) | always | Metadata from the playlist (duration, live or on-demand, variants, audio and subtitle renditions). ffmpeg reads the stream (only http, https, TLS, TCP and AES protocols) from the default audio rendition or the smallest variant; live streams are refused. Direct video URLs are downloaded through `ctx.fetch` to a temp file (capped by `VID2CONTEXT_MAX_MEDIA_MB`) and the audio extracted locally. Verified live 2026-11-14: Apple's bipbop HLS example (30 min of audio in 16 s) and Tears of Steel over HLS (86 transcript segments through the keyless OVH rung). |
| `ytdlp` | catch-all for any http(s) URL (Vimeo, TikTok, X, Reddit, Twitch, TED, ...): metadata, playlists, comments, 16 kHz mono mp3 audio; also audio for YouTube refs (Node only) | always | yt-dlp is found (`YTDLP_PATH`, `PATH`) or installed into `.vid2context/bin/` from the official release with SHA-256 verification, updated weekly (`YTDLP_AUTO_UPDATE=0` disables). Audio needs ffmpeg (`FFMPEG_PATH`). Also `YTDLP_TIMEOUT_SEC`, `YTDLP_CONCURRENCY` (default 2), `YTDLP_MAX_WAITING` (calls queued for a slot before new ones fail as busy, default 64), `YTDLP_COOKIES_FILE`, `YTDLP_COOKIES_FROM_BROWSER`. See [guides/ytdlp.md](guides/ytdlp.md). |
| `ytdlp-captions` | creator subtitles and automatic captions through yt-dlp (Node only) | always | runs after `youtube-captions` for YouTube. YouTube subtitle downloads through yt-dlp were rate-limited (HTTP 429) from a GCP VM on 2026-11-14; `vimeo.com/<id>` pages wanted a login there, so the provider retries through `player.vimeo.com`. |
| `supadata-captions` | existing YouTube captions through the Supadata transcript API, which fetches them from its own IPs (Node and Workers) | `SUPADATA_API_KEY` | free plan 100 credits a month, 1 per transcript or per "unavailable" answer, 1 request a second (pricing page, 2026-11-14). Runs last among caption providers (`order` 100), after `youtube-captions` and `ytdlp-captions`. Always `mode=native`, never AI generation. Supadata does not say whether a track is creator or auto, so results are `auto-captions` and nothing is returned when auto-captions are not allowed. Also `SUPADATA_BASE_URL`, `SUPADATA_MAX_WAIT_SEC` (default 120, async jobs polled every second). **Unverified live**: no key was available; built from docs.supadata.ai, 2026-11-14. See [guides/youtube.md](guides/youtube.md#hosted-transcript-api-supadata). |
| `share-links` | Google Drive, Dropbox, OneDrive and SharePoint file share links: filename, size, type (OneDrive: duration) and a direct download URL for speech-to-text | always | no key, Node and Workers. Drive's virus-scan page for large files is confirmed automatically; personal OneDrive uses the web viewer's anonymous token. `SHARE_LINKS_MAX_MB` (default 25) caps what is handed to speech-to-text; the keyless OVH lane takes 10 MB. Verified live 2026-11-14. See [providers/share-links](../providers/share-links/README.md). |
| `bilibili` | Bilibili videos (`bilibili.com/video/BV...` and `av...`, `?p=` parts, `?p=all` part lists, `b23.tv` short links, `m.` and player embeds): metadata, tags, chapters, multi-part listing, DASH audio for speech-to-text | always | no key, Node and Workers. Audio is downloaded by the provider with the Referer bilibili's media hosts require, capped by `BILIBILI_MAX_AUDIO_MB` (default 50). Player endpoints use the WBI signature (ported from yt-dlp). Risk control answers `blocked`. Verified live from a US VM 2026-11-14. See [providers/bilibili](../providers/bilibili/README.md). |
| `bilibili-captions` | creator subtitles (`creator-captions`) and bilibili AI subtitles (`auto-captions`) | always | the subtitle list comes from `/x/v2/dm/view`, which returns fetchable URLs without login (the player API hides them when logged out). `BILIBILI_SESSDATA` (optional) adds the logged-in player list. No machine translation. |
| `x` | X (Twitter) posts (`x.com` and `twitter.com` status links, `mobile.`, `/i/status/`, fxtwitter and vxtwitter links, `/video/<n>` positions): post text, author, date, duration, poster, every MP4 quality as a direct link in `extra.variants`, audio for speech-to-text | always | no key, Node and Workers. X's syndication endpoint first, then FxTwitter (`X_FXTWITTER=0` turns it off, `X_FXTWITTER_BASE_URL` for a self-hosted FxEmbed). Audio is the 32 kbps audio-only HLS rendition joined into one m4a (OVH's keyless lane rejects X's MP4 files), else the smallest MP4, capped by `VID2CONTEXT_MAX_MEDIA_MB`. Public posts only; GIFs have no sound. Verified live from a US VM 2026-11-15. See [providers/x](../providers/x/README.md). |
| `vimeo` | Vimeo videos: `vimeo.com/<id>`, unlisted `vimeo.com/<id>/<hash>`, `player.vimeo.com/video/<id>[?h=]`, channel, group, showcase and album video URLs: title, owner, duration, thumbnail, upload date | always | no key, Node and Workers. oEmbed plus the public player config. Wins over `ytdlp` for these URLs; audio for speech-to-text still comes from `ytdlp`. Private and password videos answer `unavailable`. From datacenter IPs Vimeo serves a 403 bot check on the player config for non-enterprise videos: metadata then comes from oEmbed alone and captions report `blocked`. Verified live 2026-11-14. See [guides/web-pages.md](guides/web-pages.md#vimeo-loom-and-wistia). |
| `vimeo-captions` | creator tracks (`provenance: user_uploaded`, `creator-captions`) and Vimeo speech recognition (`ai_generated` or `-x-autogen`, `auto-captions`) from the player config's WebVTT `text_tracks` | always | without a language, the video's locale is taken as the spoken language. Same bot-check limit as `vimeo`. |
| `loom` | Loom `loom.com/share/<id>` (also with a title slug) and `loom.com/embed/<id>`: title, owner, duration, chapters, created time | always | no key, Node and Workers. Reads the `__APOLLO_STATE__` the public share page renders; videos not shared with anyone with the link answer `not-found`, password ones `unavailable`. Verified live 2026-11-14. |
| `loom-captions` | Loom's own transcript as WebVTT (`auto-captions`, model `instant_whisper`) | always | uses the signed captions URL the share page hands out. One language per video; no translation. |
| `wistia` | Wistia `fast.wistia.net/embed/iframe/<id>`, `fast.wistia.com/embed/medias/<id>`, `<account>.wistia.com/medias/<id>`: title, duration, created time, thumbnail | always | no key, Node and Workers. Public media JSON. Unknown ids answer `not-found`, password-protected media `unavailable`. Verified live 2026-11-14. |
| `wistia-captions` | every caption track from Wistia's public captions JSON (`creator-captions`) | always | Wistia does not say whether a track was typed or generated, nor which language is spoken: with several tracks and no `--lang`, English is used when present, else the first track. Extended audio descriptions are dropped. |
| `web-page` | `page:<url>`: every video embedded in a web page (iframes for YouTube, Vimeo, Loom, Wistia, Dailymotion, Twitch, Rumble, TED; `<video>` and `<source>`; Open Graph `og:video`; JSON-LD `VideoObject`; oEmbed links; links to video pages), de-duplicated, in page order, through `expandInput` / `listItems` | always | no key, Node and Workers. Plain URLs are left to `ytdlp`. Fetches http(s) pages only, refuses private and loopback hosts on every redirect, at most 5 redirects, 20 s per hop, 2 MB of HTML. `discoverVideos(url, ctx)` is exported for surfaces. Verified live 2026-11-14. See [guides/web-pages.md](guides/web-pages.md). |
| `web-page-transcript` | a transcript the page publishes in JSON-LD (`transcript` on a `VideoObject`), as `native-transcript` | always | for `page-video:<n>:<url>` refs, which `listItems` yields when the page has a transcript and no specific source owns the video. One segment per paragraph; no timings are invented, so the producer is `web-page-transcript/untimed`. |

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

## Speech-to-text (`stt-transformers`, Node and browser)

| Rung id | Tier | Enabled by | Free limits and notes |
|---|---|---|---|
| `stt/transformers/<model>` | local | `TRANSFORMERS_STT_MODEL` (a Hugging Face repo id or a short `onnx-community` name: `whisper-base`, `whisper-small`, `whisper-large-v3-turbo`; comma-separated for several rungs) | Whisper on Transformers.js: onnxruntime-node in Node (CPU, or `cuda`/`dml`/`coreml`), WebGPU or WASM in the browser. Fully offline after the first download (whisper-base about 290 MB in fp32), cached in `.vid2context/models/transformers/` (`VID2CONTEXT_HOME`) or the browser's Cache Storage. Detects the spoken language itself; `translate` on non-turbo multilingual models. Optional: `TRANSFORMERS_DEVICE` (`auto`, `cpu`, `cuda`, `dml`, `coreml`, `wasm`, `webgpu`), `TRANSFORMERS_DTYPE` (`fp32`, or `encoder=fp32,decoder=q4`), `TRANSFORMERS_WASM_PATH` (browser: self-hosted ONNX Runtime WASM files instead of cdn.jsdelivr.net). Node needs ffmpeg (`FFMPEG_PATH`). Measured 2026-11-14, Apollo clip (24 s), whisper-base: Node CPU about 4 to 7x realtime, headless Chromium WASM about realtime. See [guides/offline-and-browser.md](guides/offline-and-browser.md). |

## LLMs: local servers (`llm-local`)

Models on this machine: free, private, and the only rungs the `local-only` policy keeps. Each `<SERVER>_MODEL` is a comma-separated list (one rung per model, tried in order); `<SERVER>_BASE_URL` overrides the default address. Every rung streams. `npx tsx providers/llm-local/src/detect.ts` finds running servers and prints these lines for you. See [guides/local-llm.md](guides/local-llm.md).

| Rung id | Tier | Enabled by | Notes |
|---|---|---|---|
| `llm/ollama/<model>` | local | `OLLAMA_MODEL` (`OLLAMA_BASE_URL`, default `http://localhost:11434/v1`; the value with or without `/v1` works) | native `/api/chat` with `num_ctx` sized per request from the prompt and capped by the model maximum from `/api/show`, so long transcripts are never silently truncated; a prompt over the maximum fails with `too-large`. JSON mode, JSON Schema (Ollama 0.5.0 and newer). `OLLAMA_KEEP_ALIVE` (`30m`, `-1`, `0`) sets how long the model stays loaded. Verified live with Ollama 0.40.16, 2026-11-14 |
| `llm/lmstudio/<model>` | local | `LMSTUDIO_MODEL` (`LMSTUDIO_BASE_URL`, default `http://localhost:1234/v1`; optional `LMSTUDIO_API_KEY`) | JSON and JSON Schema. The context length is fixed when the model is loaded in LM Studio; raise it there for long videos |
| `llm/llamacpp/<model>` | local | `LLAMACPP_MODEL` (`LLAMACPP_BASE_URL`, default `http://localhost:8080/v1`; optional `LLAMACPP_API_KEY`) | llama.cpp `llama-server`; JSON and JSON Schema; a prompt over its `-c` context fails with `too-large`. Verified live with b12383, 2026-11-14 |
| `llm/vllm/<model>` | local | `VLLM_MODEL` (`VLLM_BASE_URL`, default `http://localhost:8000/v1`; optional `VLLM_API_KEY`) | JSON and JSON Schema; over `--max-model-len` fails with `too-large` |
| `llm/jan/<model>` | local | `JAN_MODEL` (`JAN_BASE_URL`, default `http://localhost:1337/v1`; `JAN_API_KEY` when the Jan server has one set) | plain chat |
| `llm/localai/<model>` | local | `LOCALAI_MODEL` (`LOCALAI_BASE_URL`, default `http://localhost:8080/v1`; optional `LOCALAI_API_KEY`) | JSON mode |
| `llm/local/<model>` | local | `LOCAL_LLM_BASE_URL` + `LOCAL_LLM_MODEL` (optional `LOCAL_LLM_API_KEY`) | any other OpenAI-compatible server; plain chat |

## LLMs (`llm-openai-compatible`)

| Rung id | Tier | Enabled by | Free limits and notes |
|---|---|---|---|
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

## LLMs: native Anthropic, Gemini and Vertex AI (`llm-native`)

| Rung id | Tier | Enabled by | Notes |
|---|---|---|---|
| `llm/gemini-native/gemini-3.8-flash` | free | `GEMINI_API_KEY` (+ `GEMINI_FALLBACK_KEYS`) | native `generateContent`: SSE streaming with thought summaries, `responseJsonSchema`, 1M-token context, implicit caching. Shares the AI Studio quota with `llm/gemini/...` |
| `llm/gemini-native/gemini-3.5-flash-lite` | free | `GEMINI_API_KEY` | free-tier Flash-Lite |
| `llm/anthropic/claude-haiku-5-5` | paid | `ANTHROPIC_API_KEY` (+ `ANTHROPIC_FALLBACK_KEYS`) | Messages API: prompt caching for long transcripts, structured outputs, streaming with thinking summaries; 1M context |
| `llm/anthropic/claude-sonnet-5-5` | paid | `ANTHROPIC_API_KEY` | the higher-quality Claude rung |
| `llm/vertex-gemini/gemini-3.8-flash` | paid | `GOOGLE_CLOUD_PROJECT` + `GOOGLE_ACCESS_TOKEN` or `VID2CONTEXT_GCE_METADATA=1` | Gemini on Vertex AI, location `GOOGLE_CLOUD_LOCATION` (default `us-central1`) |
| `llm/vertex-anthropic/claude-haiku-5-5` | paid | same as above | Claude on Vertex AI (`rawPredict`), location `VERTEX_ANTHROPIC_LOCATION` (default `global`) |

Model lists: `GEMINI_NATIVE_MODEL`, `ANTHROPIC_MODEL`, `VERTEX_GEMINI_MODEL`, `VERTEX_ANTHROPIC_MODEL` (comma-separated). `ANTHROPIC_BASE_URL` overrides `https://api.anthropic.com`. `VID2CONTEXT_GCE_METADATA=1` reads tokens from the GCE metadata server (Node on Google Cloud only). Verified live on 2026-11-14: only the error paths (invalid keys, and Vertex refusing a project with locked billing); answers, streaming, JSON and caching are not yet verified live. See [guides/anthropic-and-gemini.md](guides/anthropic-and-gemini.md).

## LLMs in the browser (`llm-browser`, browser only)

| Rung id | Tier | Enabled by | Notes |
|---|---|---|---|
| `llm/webllm/<model>` | local | `WEBLLM_MODEL` (comma-separated ids from WebLLM's prebuilt list, one rung each) | WebLLM on WebGPU in the page: streaming, 4096-token window. Recommended: `Llama-3.2-1B-Instruct-q4f16_1-MLC` (0.9 GB VRAM), `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` (1.6 GB), `Llama-3.2-3B-Instruct-q4f16_1-MLC` (2.3 GB); `q4f32_1` builds when the GPU lacks `shader-f16`. Ids checked against `@mlc-ai/web-llm` 0.2.88 on 2026-11-14. |
| `llm/chrome-ai/prompt-api` | local | `CHROME_AI=1` | Chrome's built-in Prompt API (Gemini Nano on device): desktop Chrome 148+ on the web, about 22 GB free disk and a 4 GB GPU or 16 GB RAM. Streaming; context size from the session's `contextWindow`. Refuses Chromium's model-less echo with `no-provider`. |

The web app sets these flags after `detectBrowserAi()`; `browserAiEnv()` turns its result into env. Neither rung advertises `json` (structured output not verified). See [guides/offline-and-browser.md](guides/offline-and-browser.md).

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

## Cloudflare Workers AI (`cloudflare-ai`)

Workers AI gives every Cloudflare account 10,000 neurons per day free, on the Free and Paid Workers plans, reset at 00:00 UTC (pricing page checked 2026-11-14). Whisper large-v3-turbo costs about 47 neurons per audio minute, so the free allocation covers roughly 3.5 hours of audio a day. Inside a Worker the rungs run through the `AI` binding (no token, no extra round trip); anywhere else speech-to-text runs over REST. Guide: [guides/cloudflare.md](guides/cloudflare.md). "Live" means verified on 2026-11-14 against the real service: REST from Node, the binding in `wrangler dev`.

| Rung id | Tier | Enabled by | Free limits and notes |
|---|---|---|---|
| `stt/cloudflare-binding/@cf/openai/whisper-large-v3-turbo` | free | `CLOUDFLARE_AI_BINDING` (the binding name, usually `AI`; Worker only) | segments, words, language detection, prompt. Live |
| `stt/cloudflare-binding/@cf/openai/whisper` | free | `CLOUDFLARE_AI_BINDING` | older and much less accurate; no language detection. Live |
| `stt/cloudflare/@cf/openai/whisper-large-v3-turbo` | free | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | REST, Node, Workers and browser. Live |
| `stt/cloudflare/@cf/openai/whisper` | free | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | REST, raw audio bytes. Live |
| `stt/cloudflare/@cf/deepgram/nova-3` | free | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | Deepgram on Workers AI, REST only. Speaker labels (`diarization`) when `stt.diarize` is set, segments with confidence, language detection. About 8 neurons per audio second (about 20 minutes of audio per free day). Runs after the Whisper rungs. Recorded 2026-11-14 |
| `llm/cloudflare-binding/@cf/meta/llama-3.3-70b-instruct-fp8-fast` | free | `CLOUDFLARE_AI_BINDING` | 24k-token context; JSON mode; streaming. Live |
| `llm/cloudflare-binding/@cf/openai/gpt-oss-120b` | free | `CLOUDFLARE_AI_BINDING` | 128k context, reasoning model (reasoning is dropped from the answer); JSON mode; streaming. Live |
| `llm/cloudflare-binding/@cf/meta/llama-4-scout-17b-16e-instruct` | free | `CLOUDFLARE_AI_BINDING` | 131k context; JSON mode; streaming. Recorded |
| `llm/cloudflare-binding/@cf/mistralai/mistral-small-3.1-24b-instruct` | free | `CLOUDFLARE_AI_BINDING` | 128k context; streaming; JSON mode not claimed (not in its schema). Recorded |
| `embed/cloudflare-binding/@cf/baai/bge-m3` | free | `CLOUDFLARE_AI_BINDING` | 1024 dimensions, 100 texts per call. Live |

- Models: `CLOUDFLARE_STT_MODEL` (speech-to-text list, binding and REST), `CLOUDFLARE_DIARIZE_MODEL` (diarizing speech-to-text list, REST only, default `@cf/deepgram/nova-3`), `CLOUDFLARE_BINDING_MODEL` (binding LLM list), comma-separated, in order. `CLOUDFLARE_EMBED_MODEL` is shared with `embed/cloudflare/...` above; for a model whose size is not built in (bge-m3, bge-large, bge-base, bge-small are), also set `CLOUDFLARE_EMBED_DIMENSIONS`.
- The REST LLM and REST embedding rungs are `llm/cloudflare/...` (free catalog) and `embed/cloudflare/...` (embeddings), not duplicated here.
- Errors: the daily allocation running out (code 3036) is `rate-limited` until 00:00 UTC; unknown or retired models are `not-found`; a rejected token is `auth`.
- Upload size: no published limit for the speech-to-text models, so no `maxBytes` is set; a request that is too large fails with `too-large` (code 3006) and the next rung is tried.

## On-screen text and slides (`visual-frames`)

Reads what a transcript misses: slide text, code, charts. `extractVisualNotes` in `@vid2context/provider-visual-frames/node` samples frames with ffmpeg, drops near-duplicates and sends each distinct frame through these rungs, free first, at most `maxFrames` (default 40) per video. See [guides/visual-notes.md](guides/visual-notes.md).

| Rung id | Tier | Enabled by | Free limits and notes |
|---|---|---|---|
| `visual/ollama/<model>` | local | `OLLAMA_VISION_MODEL` (`qwen2.5vl`, `llava`, ...; comma-separated for several rungs; `OLLAMA_BASE_URL`) | runs before tesseract when set. Image as a data URL through Ollama's OpenAI-compatible endpoint, JSON mode. Nothing leaves the machine. **Unverified live** (no Ollama on the build machine) |
| `visual/tesseract/<langs>` | local | on by default in Node and the browser (`TESSERACT_ENABLED=0` turns it off; never on Workers) | tesseract.js (WebAssembly), nothing leaves the machine. `TESSERACT_LANGS` (default `eng`, `+`-joined such as `ces+eng`); English data ships with the package, other languages download once to `.vid2context/models/tesseract`. `TESSERACT_LANG_PATH` (your own traineddata directory or URL), `TESSERACT_MIN_CONFIDENCE` (per line, default 60). Returns `ocr` notes. Verified live 2026-11-14, about 0.4 to 2 s per frame on a CPU VM |
| `visual/gemini/<model>` | free | `GEMINI_API_KEY` (+ `GEMINI_FALLBACK_KEYS`) | `GEMINI_VISION_MODEL` (default `gemini-2.5-flash-lite`). Requests spaced `GEMINI_VISION_INTERVAL_SEC` apart (default 4). Frames go to Google. **Unverified live** (no key) |
| `visual/ovh/Qwen2.5-VL-72B-Instruct` | keyless | none | `OVH_VISION_MODEL` to override. 2 requests per minute per model per IP (`x-ratelimit-limit-minute: 2`, `Retry-After` on 429, 2026-11-14), so requests are spaced `OVH_VISION_INTERVAL_SEC` apart (default 30) and the chain moves on meanwhile. Accepts JPEG data URLs and `json_object`; verified live 2026-11-14, 2 to 33 s per frame |

- Frame sampling (Node only) needs ffmpeg (`FFMPEG_PATH`) and, for URLs, yt-dlp (`YTDLP_PATH` or the managed copy from `providers/ytdlp`).
- The Workers build resolves the package to its edge entry, which has the vision rungs only.

## Chain controls

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

The library (saved contexts, collections, search, key-value state, vectors) uses the enabled storage backend with the lowest priority. Guides: [guides/library-sqlite.md](guides/library-sqlite.md), [guides/library-postgres.md](guides/library-postgres.md).

| Priority | Backend | Runtime | Enabled when |
|---|---|---|---|
| 10 | Postgres + pgvector (`storage-postgres`), tsvector search, HNSW vector search, tenants | node; workers with Neon | `VID2CONTEXT_DATABASE_URL` or `DATABASE_URL` is set, unless `VID2CONTEXT_STORAGE` names another backend. See [guides/library-postgres.md](guides/library-postgres.md) |
| 50 | SQLite (`storage-sqlite`), FTS5 search, one local file | node (22.13+) | by default, unless `VID2CONTEXT_STORAGE` names another backend |
| 20 | Cloudflare D1 (`storage-cloudflare`), FTS5 search, R2 for large contexts, KV for state | workers | `VID2CONTEXT_D1` names a D1 binding, unless `VID2CONTEXT_STORAGE` names another backend. See [guides/cloudflare.md](guides/cloudflare.md) |
| none | in-process `MemoryStorage`, lost on exit | any | no backend is enabled, or `VID2CONTEXT_STORAGE=memory` |

| Env var | Used by | Notes |
|---|---|---|
| `VID2CONTEXT_STORAGE` | storage providers | pick one backend: `sqlite`, `postgres`, `cloudflare`, or `memory` (no persistent backend). Unset: the priority order above |
| `VID2CONTEXT_DB` | `storage-sqlite` | path of the SQLite file, or `:memory:`; default `<VID2CONTEXT_HOME>/library.db` |
| `VID2CONTEXT_HOME` | `storage-sqlite` and other local data | data directory; default `.vid2context` in the working directory |
| `VID2CONTEXT_DB_BUSY_TIMEOUT_MS` | `storage-sqlite` | how long a write waits for another process holding the file; default 5000 |
| `VID2CONTEXT_D1` | `storage-cloudflare` | name of the Worker's D1 binding (for example `DB`); enables the backend |
| `VID2CONTEXT_R2` | `storage-cloudflare` | optional R2 binding name: contexts over 1,000,000 bytes of JSON go there (a D1 row holds at most 2 MB), and uploaded media blobs |
| `VID2CONTEXT_KV` | `storage-cloudflare` | optional KV binding name for key-value state (TTLs under 60 s are raised to 60, the KV minimum); without it the state lives in a D1 table |
| `VID2CONTEXT_DATABASE_URL` | `storage-postgres` | Postgres connection string; wins over `DATABASE_URL`. Setting either enables the backend. SSL from `?sslmode=` |
| `DATABASE_URL` | `storage-postgres` | the conventional name many hosts set; used when `VID2CONTEXT_DATABASE_URL` is unset |
| `VID2CONTEXT_PG_SCHEMA` | `storage-postgres` | schema for the tables; default `vid2context`. Created and migrated on first start |
| `VID2CONTEXT_TENANT` | `storage-postgres` | tenant id stamped on and filtered by every row; default `default` |
| `VID2CONTEXT_PG_POOL_MAX` | `storage-postgres` | pool size on Node; default 10 |
| `VID2CONTEXT_PG_STATEMENT_TIMEOUT_MS` | `storage-postgres` | per-statement timeout sent at connect; unset uses the server default (PgBouncer-style poolers reject it) |
| `VID2CONTEXT_PG_DRIVER` | `storage-postgres` | `postgres` (TCP, Node default) or `neon-http` (Neon over HTTPS, the Workers default) |
| `VID2CONTEXT_PG_NEON_FETCH_ENDPOINT` | `storage-postgres` | Neon HTTP endpoint override for a local Neon proxy or self-hosted Neon |

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

## HTTP API server

Read by `@vid2context/server` (`npm run start:server`, the Worker, containers). See [guides/http-api.md](guides/http-api.md) and [contracts/http-api.md](contracts/http-api.md). Every variable is optional.

| Env var | Effect |
|---|---|
| `PORT`, `HOST` | Node listen address; default `8787` on `127.0.0.1` (not reachable from the network until you set `HOST=0.0.0.0`) |
| `VID2CONTEXT_API_KEYS` | comma-separated API keys; when set, every `/api/*` route except `/health` needs `Authorization: Bearer <key>`. Plain keys have full access; hashed entries `name:scope:sha256hex` (scope `read`, `write` or `admin`) keep the key itself out of the config. Ignored in hosted mode |
| `VID2CONTEXT_RATE_LIMIT` | requests per minute per key, or per client IP in open mode; default `120`, `0` off. Answers 429 with `Retry-After` |
| `VID2CONTEXT_RATE_BURST` | requests allowed at once before the per-minute rate applies; default half of `VID2CONTEXT_RATE_LIMIT` |
| `VID2CONTEXT_TRUST_PROXY` | `1` behind a reverse proxy you control: take the client IP from `X-Forwarded-For` or `X-Real-IP`. Off by default because clients can forge them |
| `VID2CONTEXT_CORS_ORIGINS` | browser origins allowed to call `/api/*` (`https://vid2context.com`, `chrome-extension://<id>`, or `*`), comma-separated; shared with `/mcp`. Off by default |
| `VID2CONTEXT_MAX_BODY_KB` | largest JSON body; default `1024` |
| `VID2CONTEXT_MAX_UPLOAD_MB` | largest `POST /uploads` file. The HTTP API's default is `100` (the Workers free-plan request limit) when this is unset |
| `VID2CONTEXT_UPLOAD_TTL_MIN` | minutes an upload stays available; default `60`. Kept in R2 (`VID2CONTEXT_R2`) when the Cloudflare storage has a bucket, else in memory |
| `VID2CONTEXT_REQUEST_TIMEOUT_MS` | longest a request may run before it is answered with `timeout` (504); default `300000` |
| `VID2CONTEXT_ACCESS_LOG` | `0` turns off the JSON access log line per request on stderr |
| `VID2CONTEXT_REQUEST_KEYS` | `0` stops accepting provider keys sent per request in `X-Vid2Context-Keys`. On by default: a caller whose run failed for lack of a key can retry with its own, used for that request only and never stored. Only credential names registered providers declare are accepted (see [contracts/http-api.md](contracts/http-api.md#provider-keys-per-request)) |
| `VID2CONTEXT_SHUTDOWN_TIMEOUT_MS` | Node: how long in-flight requests may finish after `SIGTERM` or `SIGINT`; default `10000` |

## Exports

| Env var | Used by | Notes |
|---|---|---|
| `NOTION_TOKEN` | `@vid2context/exporters` (`export_notion`, `POST /exports/notion`) | secret of an internal integration (free) from https://www.notion.so/profile/integrations; share the parent page with it (page menu, Connections). Requests are paced to about 3 per second and use `Notion-Version: 2026-03-11` |
| `NOTION_PARENT_PAGE_ID` | `@vid2context/exporters` | id or link of the Notion page the video pages go under; a per-call `parentPageId` wins |

Obsidian exports need no variable: they are local files.

## Collections and watch lists

Read by `@vid2context/library` (collection refresh, watch lists). See [guides/collections.md](guides/collections.md). A refresh reads at most `VID2CONTEXT_MAX_PLAYLIST_ITEMS` items per source and ingests at most that many per run.

| Variable | Meaning |
|---|---|
| `VID2CONTEXT_WEBHOOK_URL` | POST `{ collection: { id, name }, added: VideoSummary[], checkedAt }` here after a refresh adds videos; retried with backoff on 5xx and 429, never blocks or fails the refresh |
| `VID2CONTEXT_WEBHOOK_SECRET` | signs that POST: `X-Vid2context-Signature: sha256=<hex HMAC-SHA256 of the raw body>`, plus `X-Vid2context-Timestamp` (unix seconds). Unset: sent unsigned |

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

## Background jobs

The job engine from `@vid2context/jobs` (`POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/events`, `DELETE /jobs/:id`). The in-process runner needs nothing; the Cloud Tasks adapter needs all three `CLOUD_TASKS` variables. Guide: `docs/guides/jobs.md`.

| Env var | Used by | Notes |
|---|---|---|
| `VID2CONTEXT_JOB_CONCURRENCY` | `@vid2context/jobs` | jobs that run at once in the in-process runner, default `2` |
| `VID2CONTEXT_JOB_TTL_HOURS` | `@vid2context/jobs` | hours a finished job is kept (KvStore TTL), default `72` |
| `VID2CONTEXT_CLOUD_TASKS_QUEUE` | `@vid2context/jobs` | `projects/<project>/locations/<location>/queues/<queue>` |
| `VID2CONTEXT_CLOUD_TASKS_RUN_URL` | `@vid2context/jobs` | public https base of the API including `/api/v1`; tasks POST to `<url>/jobs/<id>/run` |
| `VID2CONTEXT_CLOUD_TASKS_SERVICE_ACCOUNT` | `@vid2context/jobs` | service account Cloud Tasks signs the OIDC token as; the run endpoint requires it |
| `VID2CONTEXT_CLOUD_TASKS_AUDIENCE` | `@vid2context/jobs` | OIDC audience the run endpoint expects, default the run URL |

## Remote MCP server

The MCP tools over Streamable HTTP at `/mcp`, for ChatGPT and Claude.ai connectors, from `@vid2context/mcp-http`. See [guides/remote-mcp.md](guides/remote-mcp.md) and [guides/cloudflare-tunnel.md](guides/cloudflare-tunnel.md).

| Env var | Used by | Notes |
|---|---|---|
| `VID2CONTEXT_MCP_TOKENS` | `@vid2context/mcp-http` | static bearer tokens, comma-separated, compared by SHA-256 in constant time. Without these and without `VID2CONTEXT_OWNER_PASSWORD_HASH`, `/mcp` refuses every request |
| `VID2CONTEXT_OWNER_PASSWORD_HASH` | `@vid2context/mcp-http` | turns on the OAuth 2.1 server (dynamic registration, Client ID Metadata Documents, PKCE S256, rotating refresh tokens). Format `scrypt:<log2 N>:<r>:<p>:<salt>:<hash>`, made by `vid2context-mcp-http hash-password` |
| `VID2CONTEXT_MCP_PUBLIC_URL` | `@vid2context/mcp-http` | public origin (`https://mcp.vid2context.com`). The OAuth issuer, the resource tokens are bound to (`<origin>/mcp`) and the server card URL. Default: the request's origin |
| `VID2CONTEXT_CORS_ORIGINS` | `@vid2context/mcp-http`, HTTP API | browser origins allowed on `/mcp` and `/oauth/{register,token,revoke}`. An `Origin` that is not listed gets 403 on `/mcp` |
| `VID2CONTEXT_MCP_ALLOWED_HOSTS` | `@vid2context/mcp-http` | extra Host values for the DNS-rebinding check the bin applies when it listens on loopback (loopback names and the public host always pass) |
| `VID2CONTEXT_MCP_RATE_LIMIT` | `@vid2context/mcp-http` | requests per minute per token, default `120`, `0` off. Answers 429 with `Retry-After` |
| `VID2CONTEXT_MCP_MODE`, `VID2CONTEXT_MCP_SESSION_IDLE_SEC` | `@vid2context/mcp-http` | `session` (default on Node) or `stateless` (default on Workers). Idle sessions close after 1800 s by default |
| `VID2CONTEXT_OAUTH_ACCESS_TTL_SEC`, `VID2CONTEXT_OAUTH_REFRESH_TTL_SEC` | `@vid2context/mcp-http` | token lifetimes, default 3600 and 2592000 (30 days) |
| `VID2CONTEXT_OAUTH_ALLOWED_REDIRECTS` | `@vid2context/mcp-http` | redirect URI prefixes clients may use. Unset: any https URI, or http on localhost |
| `VID2CONTEXT_OPENAI_APPS_CHALLENGE` | `@vid2context/mcp-http` | OpenAI app directory domain verification token, served at `/.well-known/openai-apps-challenge` |

OAuth clients, codes and tokens are kept in the storage backend when it implements `KvStore`, under `auth:oauth:` keys. Otherwise they live in process memory, and a restart signs every connector out.

## Live streams (`@vid2context/live`, Node only)

`watch_live` (MCP) and `GET /live` (HTTP) follow a live YouTube video or HLS (`.m3u8`) stream and transcribe it in 30 s chunks through the speech-to-text chain above, so the same rungs, order and cooldowns apply. Needs ffmpeg (`FFMPEG_PATH`, see `ytdlp` above). A stream needs about 2 requests and 64 audio seconds per minute: local rungs, Groq's free tier and Workers AI keep up; the keyless OVH rung (2 requests per minute per IP) only for a few minutes. Verified live 2026-11-14 on a YouTube live stream with the Workers AI REST rung: 31 lines in 2 minutes, 12 to 46 s behind the live picture. See [packages/live/README.md](../packages/live/README.md).

| Env var | Used by | Notes |
|---|---|---|
| `VID2CONTEXT_LIVE_TEST_URL` | `packages/live` LIVE test | the live stream the `LIVE=1` test follows for two minutes; default NASA's ISS stream on YouTube |

## Video and audio downloads (`@vid2context/downloads`, Node only)

`vid2context download`, the `get_media_options` and `download_media` MCP tools (stdio server only), `/api/v1/downloads` and the web app's Download section save a video as mp4, webm or mkv, or its audio as mp3, m4a, opus, flac or wav. Web URLs go through the `ytdlp` provider's managed binary (so `YTDLP_*` and the cookies apply), local files through ffmpeg (`FFMPEG_PATH`). See [guides/downloads.md](guides/downloads.md).

| Env var | Notes |
|---|---|
| `VID2CONTEXT_DOWNLOADS` | unset: on locally, off when `VID2CONTEXT_PUBLIC=1`. `1` allows downloads on a public server, `0` turns them off everywhere |
| `VID2CONTEXT_DOWNLOAD_DIR` | where the CLI (default: current directory) and the MCP tool (default `~/Downloads/vid2context`) save files |
| `VID2CONTEXT_MAX_DOWNLOAD_MB` | largest file; `0` = no limit (default locally, 1024 on public servers) |
| `VID2CONTEXT_MAX_DOWNLOAD_MIN` | longest kept part in minutes; `0` = no limit (default locally, 120 on public servers) |
| `VID2CONTEXT_DOWNLOAD_TTL_MIN` | HTTP server: minutes a finished file stays downloadable (default 30) |
| `VID2CONTEXT_DOWNLOAD_CONCURRENCY` | HTTP server: downloads that run at once (default 2), separate from `YTDLP_CONCURRENCY` |
| `VID2CONTEXT_MAX_DOWNLOAD_JOBS` | HTTP server: jobs kept (queued, running, finished) before new ones get `rate-limited` (default 50) |
| `VID2CONTEXT_DOWNLOAD_TIMEOUT_SEC` | longest one download may run (default 7200) |

## Planned (see ROADMAP.md)

| Kind | Provider | Tier | Enabled by | Known limits |
|---|---|---|---|---|
| stt | Gemini audio, Deepgram direct API, AssemblyAI | free (sign-up credits) | `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY` | not built: no key to record real responses (2026-11-15) |
| video | Gemini video understanding | free | `GEMINI_API_KEY` | not built: no key to record real responses (2026-11-15) |
