# Speech-to-text

When a video has no usable captions, vid2context sends its audio through a chain of speech-to-text rungs, cheapest and most private first: local, then free tiers with your key, then keyless hosts, then paid services (only when their key is set). The first rung that succeeds wins; a rung that hits a rate limit cools down for as long as the service asked (`retry-after` or `x-ratelimit-*` headers) and the next one runs. Full rung table and env vars: [../providers.md](../providers.md).

## Which option to use

| Option | Rung id | Privacy | Cost | Speed | Upload limit | Word timestamps | Guide |
|---|---|---|---|---|---|---|---|
| Local OpenAI-compatible server (speaches, faster-whisper-server, LocalAI) | `stt/local/<model>` | stays on your machine | free | depends on your hardware | none | not requested | this page |
| whisper.cpp | `stt/whisper-cpp/<model>` | stays on your machine | free | fast on GPU and Apple Silicon | none | see guide | [whisper-cpp.md](whisper-cpp.md) |
| Transformers.js (Node and browser) | `stt/transformers/<model>` | stays on your device | free | slower, no install | none | see guide | [offline-and-browser.md](offline-and-browser.md) |
| Groq | `stt/groq/whisper-large-v3-turbo` | sent to Groq | free tier | very fast | 25 MB | yes | this page |
| Mistral Voxtral | `stt/mistral/voxtral-mini-transcribe-3` | sent to Mistral; the free Experiment plan may train on your data | free tier | fast | not published | no (segments only) | this page |
| Cloudflare Workers AI | `stt/cloudflare/...` | sent to Cloudflare | free daily allocation | fast | see guide | see guide | [cloudflare.md](cloudflare.md) |
| Deepgram nova-3 on Cloudflare (speaker labels) | `stt/cloudflare/@cf/deepgram/nova-3` | sent to Cloudflare | free daily allocation, about 20 minutes of audio a day | fast | see guide | no (segments with confidence) | [diarization.md](diarization.md) |
| OVH AI Endpoints | `stt/ovh/whisper-large-v3-turbo` | sent to OVH without an account | free, no key | moderate, about 2 requests per minute per IP | not published | yes | this page |
| DeepInfra | `stt/deepinfra/openai/whisper-large-v3-turbo` | sent to DeepInfra | paid, about $0.0002 per audio minute | fast | not published | yes | this page |
| Together | `stt/together/openai/whisper-large-v3` | sent to Together | paid | fast | 80 MB | yes | this page |
| OpenAI | `stt/openai/whisper-1` | sent to OpenAI | paid, the last backstop | moderate | 25 MB | yes | this page |

Direct Deepgram and AssemblyAI rungs and a Gemini audio rung are not included: they need a `DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY` or `GEMINI_API_KEY` to record real responses, and none was available (2026-11-15). Audio larger than a rung's upload limit skips that rung; splitting long audio is handled by the pipeline.

Rules of thumb:

- Nothing may leave the machine: run a local server or whisper.cpp and set `VID2CONTEXT_POLICY=local-only`.
- Free and fast: set `GROQ_API_KEY`. Add more keys in `GROQ_FALLBACK_KEYS` for more quota (each key is its own rung).
- Zero setup: OVH keyless works with no configuration. `VID2CONTEXT_KEYLESS=0` turns it off.
- Free tiers versus credits: Groq and Mistral (Experiment plan) are real free tiers and rank before keyless. DeepInfra, Together and OpenAI bill per use and run last.

## Local servers

Any server that implements `POST /v1/audio/transcriptions` works. Point `LOCAL_STT_BASE_URL` at it and set `LOCAL_STT_MODEL`:

| Server | `LOCAL_STT_BASE_URL` | Recommended `LOCAL_STT_MODEL` | Start it |
|---|---|---|---|
| speaches (formerly faster-whisper-server) | `http://localhost:8000/v1` | `Systran/faster-whisper-large-v3` (or `deepdml/faster-whisper-large-v3-turbo-ct2` for speed) | `docker run --rm -d -p 8000:8000 -v hf-hub-cache:/home/ubuntu/.cache/huggingface/hub ghcr.io/speaches-ai/speaches:latest-cpu` (with an NVIDIA GPU: add `--gpus=all` and use `latest-cuda`) |
| LocalAI | `http://localhost:8080/v1` | `whisper-1` (the model name LocalAI's audio-to-text docs configure with `backend: whisper`) | see localai.io, "Audio to text" |

Set `LOCAL_STT_API_KEY` only if your server requires one. These defaults are exported as `LOCAL_STT_PRESETS` from `@vid2context/provider-stt-openai-compatible`.

## Better transcripts for free

- **Prompt biasing.** Whisper spells names and jargon better when they appear in the prompt. `promptFromMetadata(metadata)` builds one from the video's title, channel name, chapter titles and tags (800 characters by default, inside Whisper's 224-token window). Pass it as `SttOptions.prompt`. Mistral receives it as `context_bias`.
- **Language.** Pass `SttOptions.language` (any BCP-47 tag; it is reduced to the two-letter code) when you know it; otherwise the detected language is reported.
- **Word timestamps.** Rungs with the `words` capability return each segment's words with start and end times.
