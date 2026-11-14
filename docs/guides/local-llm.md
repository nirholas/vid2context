# Local LLMs

Run the language model on your own machine: free, private, and the only option under `VID2CONTEXT_POLICY=local-only`. vid2context talks to the local servers people already use. The rungs live in `providers/llm-local`.

## Find what is running

```sh
npx tsx providers/llm-local/src/detect.ts          # readable report
npx tsx providers/llm-local/src/detect.ts --json   # the same, as JSON
```

It probes the default ports below (and any base URL already set in `.env`) with short timeouts, lists the installed models with their context length, reports RAM and NVIDIA GPU memory, recommends a model per task (the largest chat model that fits for briefs, the smallest for cleanup, an embedding model, a speech-to-text server), and prints the lines to paste into `.env`. It only talks to the addresses it probes. Code can call `detectLocalServers(ctx, { timeoutMs })` from `@vid2context/provider-llm-local`.

Servers are identified by their own responses: Ollama by `/api/version`, llama.cpp and whisper.cpp by their `Server` header, vLLM by its `/v1/models` fields. Anything else that answers `/v1/models` is reported with the names of the servers that usually use that port.

## Servers

| Server | Default address | Enable with | Also |
|---|---|---|---|
| Ollama | `http://localhost:11434` | `OLLAMA_MODEL` | `OLLAMA_BASE_URL`, `OLLAMA_KEEP_ALIVE` |
| LM Studio | `http://localhost:1234/v1` | `LMSTUDIO_MODEL` | `LMSTUDIO_BASE_URL`, `LMSTUDIO_API_KEY` |
| llama.cpp (`llama-server`) | `http://localhost:8080/v1` | `LLAMACPP_MODEL` | `LLAMACPP_BASE_URL`, `LLAMACPP_API_KEY` |
| vLLM | `http://localhost:8000/v1` | `VLLM_MODEL` | `VLLM_BASE_URL`, `VLLM_API_KEY` |
| Jan | `http://localhost:1337/v1` | `JAN_MODEL` | `JAN_BASE_URL`, `JAN_API_KEY` |
| LocalAI | `http://localhost:8080/v1` | `LOCALAI_MODEL` | `LOCALAI_BASE_URL`, `LOCALAI_API_KEY` |
| any OpenAI-compatible server | none | `LOCAL_LLM_BASE_URL` + `LOCAL_LLM_MODEL` | `LOCAL_LLM_API_KEY` |

Each `<SERVER>_MODEL` is a comma-separated list. Every model becomes its own rung (`llm/ollama/qwen2.5:7b`, `llm/llamacpp/<id>`), tried in the order listed. API keys are only for servers you started with one. Every rung streams.

Ollama uses its native API. The others use OpenAI-compatible chat completions.

Quick start with Ollama:

```sh
ollama pull qwen2.5:7b
echo 'OLLAMA_MODEL=qwen2.5:7b' >> .env
npx tsx providers/llm-local/src/detect.ts   # confirms the server and model
```

Add `VID2CONTEXT_POLICY=local-only` to `.env` to keep every LLM call on this machine.

## The context-window trap, and how it is handled

Ollama loads a model with a small default context and, when a prompt is longer, silently drops its beginning. Measured on 2026-11-14 with Ollama 0.40.16: the model loaded with `n_ctx = 4096`, and a question about an 18-minute transcript (about 4,600 tokens) through the OpenAI-compatible endpoint was cut to 2,050 tokens (`truncating input prompt limit=2050 prompt=4626` in the server log). The model then named the wrong host, because the introduction was gone. There was no error.

vid2context avoids this:

- It uses Ollama's native `POST /api/chat`, the only endpoint that accepts `options.num_ctx`.
- It reads each model's maximum context once from `POST /api/show` and caches it.
- Each request gets `num_ctx` = estimated prompt tokens (plus 15% for estimate error) + the answer budget, rounded up to a multiple of 2048 so similar requests reuse the loaded model, never above the model maximum. The answer budget (`num_predict`) is clamped so generation cannot run past the window either.
- A prompt bigger than the model maximum fails with `too-large` and a hint naming a larger-context model. The chain then moves to the next rung instead of answering from half a transcript.

The same question with this rung: `num_ctx` 6144, all 4,644 prompt tokens evaluated, and `qwen2.5:3b` answered both the host's name from the first minute and the recommendation from the last.

Other servers:

- llama.cpp and vLLM refuse an over-long prompt with an error, which becomes `too-large`. Start them with enough context for your videos: `llama-server -c 32768`, `vllm serve --max-model-len 32768`. llama.cpp's `/v1/models` shows the context it was started with (`meta.n_ctx`), and detection reports it.
- LM Studio and Jan fix the context length when the model is loaded. Raise it in their model settings for long videos.

Rough sizing: English speech is about 255 tokens per minute of transcript, so 8k tokens hold about 24 minutes and 32k about 2 hours, before the question and answer.

## OLLAMA_BASE_URL

Earlier versions documented `OLLAMA_BASE_URL=http://localhost:11434/v1`. That still works: this package strips a trailing `/v1` (or `/api`) to reach the native API, and the embedding and vision providers keep using the `/v1` form. Detection prints the `/v1` form for that reason.

## Keeping models loaded

Ollama unloads a model after five minutes idle. `OLLAMA_KEEP_ALIVE=30m` keeps it for 30 minutes after each request, `-1` keeps it loaded, `0` unloads it right away.

## Embeddings and speech-to-text

Detection also reports:

- Ollama embedding models (`nomic-embed-text`, `bge-m3`, `mxbai-embed-large`) with an `OLLAMA_EMBED_MODEL` line for the embeddings provider.
- Local speech-to-text servers: speaches or faster-whisper-server (usually port 8000) and the whisper.cpp server (usually port 8080), with `LOCAL_STT_BASE_URL` and `LOCAL_STT_MODEL` lines for the OpenAI-compatible speech-to-text rung. Start whisper-server with `--inference-path /v1/audio/transcriptions` so it answers that route (verified with whisper.cpp b5454).

## In the browser

The rungs use plain `fetch`, so a web page can call a local server directly when the server allows the page's origin:

- Ollama allows localhost origins by default and returns 403 for others. Allow your site with `OLLAMA_ORIGINS=https://your.site` (comma-separated, `*` for any) in the environment of `ollama serve`.
- llama.cpp `llama-server` answers cross-origin requests by default.
- LM Studio: turn on "Enable CORS" in the server settings.
- vLLM: `--allowed-origins '["https://your.site"]'`.
- LocalAI: start it with CORS enabled (`--cors`).
- Jan: allow the origin in the local API server settings.

Some browsers also ask before a public page may reach `localhost`.

## Choosing a model

Detection recommends from what you have installed. Starting points by memory (GPU memory if you have one, otherwise RAM): 6 GB `qwen2.5:3b`, 12 GB `qwen2.5:7b`, 24 GB `qwen2.5:14b`. For very long videos pick a model with a 128k context, such as `llama3.1:8b`. A small model like `qwen2.5:0.5b` is fast for cleanup but too weak for briefs.
