# cloudflare-ai fixtures

Real responses from Cloudflare Workers AI, recorded on 2026-11-14 by POSTing to
`https://api.cloudflare.com/client/v4/accounts/<account>/ai/run/<model>` with the owner's
account and an API token. Bodies are stored exactly as returned. They contain no account id,
IP address or personal data (checked with grep before committing).

Speech-to-text input: `tests/fixtures/media/apollo11-small-step.mp3` (public domain, NASA).

| File | Request | Response |
|---|---|---|
| `whisper-large-v3-turbo.apollo.json` | `@cf/openai/whisper-large-v3-turbo`, JSON `{ "audio": <base64 mp3> }` | 200, segments with words, language `en` |
| `whisper.apollo.json` | `@cf/openai/whisper`, raw mp3 bytes with `content-type: audio/mpeg` | 200, `text`, `words`, `vtt` (first cue has no start time), no language |
| `bge-m3.embed.json` | `@cf/baai/bge-m3`, `{ "text": [two sentences] }` | 200, `data` of shape [2, 1024] |
| `llama-3.3-70b.chat.json` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `messages`, `max_tokens: 200` | 200, OpenAI-shaped `choices` plus `response` |
| `llama-3.3-70b.json-mode.json` | same model, `response_format: { "type": "json_object" }` | 200, `response` is a parsed object |
| `llama-3.3-70b.stream.sse` | same model, `stream: true`, `max_tokens: 60` | 200, `text/event-stream` chunks, final `{ response, usage }`, `[DONE]` |
| `gpt-oss-120b.chat.json`, `gpt-oss-120b.json-mode.json` | `@cf/openai/gpt-oss-120b`, chat and JSON mode | 200, answer plus `reasoning` (the chat one stopped at `finish_reason: length`) |
| `llama-4-scout.chat.json`, `llama-4-scout.json-mode.json` | `@cf/meta/llama-4-scout-17b-16e-instruct`, chat and JSON mode | 200 |
| `mistral-small-3.1.chat.json`, `mistral-small-3.1.json-mode.json` | `@cf/mistralai/mistral-small-3.1-24b-instruct`, chat and JSON mode | 200 |
| `nova-3.apollo.diarize.json` | `@cf/deepgram/nova-3?diarize=true&smart_format=true&punctuate=true&utterances=true&paragraphs=true&detect_language=true`, raw mp3 (`ffmpeg -vn -ac 1 -ar 16000 -b:a 32k` of the NASA "Armstrong Small Step.ogg" on Wikimedia Commons, the same recording as the Apollo fixture) | 200, 4 utterances, all speaker 0, word confidences, language `en` in `alternatives[0].languages` (no `detected_language`), about 190 neurons |
| `nova-3.nixon-call.diarize.json` | same query, raw mp3 of "President Nixon speaking with astronauts Armstrong and Aldrin on the Moon.webm" (Wikimedia Commons, Richard Nixon Presidential Library, public domain), 202 s | 200, 28 utterances, speakers 0, 1 and 2, about 1,600 neurons |
| `error-model-not-found.json` | `@cf/openai/whisper-does-not-exist` | 400, code 7000 "No route for that URI" |
| `error-bad-token.json` | `@cf/baai/bge-m3` with a deliberately invalid token | 401, code 10000 "Authentication error" |
| `error-bad-input.json` | `@cf/openai/whisper-large-v3-turbo` with base64 of the text "not audio" | 400, code 3030 "Failed to decode audio file" |
| `binding-error-unknown-model.txt` | `env.AI.run('@cf/openai/whisper-does-not-exist', ...)` inside `wrangler dev` (test/worker) | the message of the Error the binding threw |

The two `nova-3.*` files were recorded on 2026-11-14 by `packages/speakers/test/record-fixtures.ts` (its
`nova3-*.json`, copied here byte for byte) with exactly the request the `stt/cloudflare/@cf/deepgram/nova-3`
rung sends. A response with `diarize=false` has not been recorded: the test for that path parses the
diarized recording with speakers turned off. Re-recording on 2026-11-15 was not possible because the
API token in `.env` was rejected (code 10000) for every model.

The chat requests used the prompts in `../cloudflare-ai.test.ts` (`messages` and `jsonMessages`).
Re-record by sending the same requests; the binding tests replay these REST bodies because the
binding returns the same `result` object that REST wraps in `{ result, success, errors, messages }`.
