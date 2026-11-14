# llm-local fixtures

Real responses recorded on 2026-11-14 on a Linux x86_64 machine (32 CPU threads, no GPU), each server on its own loopback port. No keys were involved. Files ending in `.http` are raw `curl -i` output (status line, headers, body); `.txt` files with a trailing number were saved with `curl -w '\n%{http_code}'` (body, then the status).

Servers:

- Ollama 0.40.16 (release tarball `ollama-linux-amd64.tar.zst`) on `127.0.0.1:24434`, models `qwen2.5:0.5b`, `qwen2.5:3b`, `nomic-embed-text`.
- llama.cpp server b12383 (`llama-b12383-bin-ubuntu-x64.tar.gz`) on `127.0.0.1:25080`, serving the same `qwen2.5:0.5b` GGUF (Q4_K_M) with `--alias qwen2.5-0.5b-instruct-q4_k_m -c 8192`.
- whisper.cpp server b5454 (`whisper-bin-ubuntu-x64.tar.gz`) on `127.0.0.1:26080` with `ggml-tiny.en.bin`.

The chat prompt is "Which year did Apollo 11 land on the moon? Answer in one short sentence." (with "Use keys year and mission." for the JSON ones), `temperature: 0`.

| File | Request | Notes |
|---|---|---|
| `ollama-api-version.http` | Ollama `GET /api/version` | identifies Ollama |
| `ollama-root.txt` | Ollama `GET /` | "Ollama is running" |
| `ollama-tags.json` | Ollama `GET /api/tags` | three models; this version also reports `context_length` and `capabilities` here |
| `ollama-show-qwen2.5-0.5b.json` | Ollama `POST /api/show {"model":"qwen2.5:0.5b"}` | `qwen2.5.context_length` 32768, capabilities completion and tools |
| `ollama-show-qwen2.5-3b.json` | same for `qwen2.5:3b` | |
| `ollama-show-nomic-embed-text.json` | same for `nomic-embed-text:latest` | context 2048, capability embedding |
| `ollama-show-missing.txt` | `POST /api/show {"model":"llama3.3:70b"}` (not installed) | 404 `model ... not found` |
| `ollama-v1-models.http` | Ollama `GET /v1/models` | every entry `owned_by: library` |
| `ollama-chat.json` | `POST /api/chat`, `stream: false`, `num_ctx` 2048, `num_predict` 64 | |
| `ollama-chat-stream.ndjson` | same with `stream: true` | one JSON object per line, last with `done: true` and token counts |
| `ollama-chat-json.json` | `POST /api/chat` with `format: "json"` | |
| `ollama-chat-schema.json` | `POST /api/chat` with a JSON Schema in `format` | |
| `ollama-chat-long-transcript.request.json` | the body this package sent for a question about both ends of the 18-minute transcript in `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` | recorded by `test/record.ts` with `qwen2.5:0.5b`; `num_ctx` 6144 |
| `ollama-chat-long-transcript.response.json` | Ollama's answer to it | `prompt_eval_count` 4644: the whole prompt. The same request through `/v1/chat/completions` evaluated 2050 tokens (the default window) |
| `llamacpp-v1-models.http` | llama.cpp `GET /v1/models` | `Server: llama.cpp`, `meta.n_ctx` 8192 |
| `llamacpp-health.http` | llama.cpp `GET /health` | |
| `llamacpp-api-version.http` | llama.cpp `GET /api/version` | 404, so it is never mistaken for Ollama |
| `llamacpp-chat.json` | `POST /v1/chat/completions` | |
| `llamacpp-chat-stream.sse` | same with `stream: true`, `stream_options.include_usage` | SSE with a final usage chunk and `[DONE]` |
| `llamacpp-chat-schema.json` | `POST /v1/chat/completions` with `response_format: json_schema` | |
| `llamacpp-chat-too-large.txt` | the transcript twice (9176 tokens) against `-c 8192` | 400 `exceed_context_size_error` |
| `whispercpp-root.http` | whisper.cpp `GET /` | `Server: whisper.cpp`, HTML title "Whisper.cpp Server" |
| `whispercpp-v1-models.http` | whisper.cpp `GET /v1/models` | 404 with `Server: whisper.cpp` |
| `whispercpp-api-version.http` | whisper.cpp `GET /api/version` | 404 |

Scrubbed: the local models directory in the `modelfile` field of the `/api/show` responses is replaced with `[models dir]`. Nothing else was changed.
