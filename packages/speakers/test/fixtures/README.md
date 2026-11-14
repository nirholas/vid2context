# Speaker-naming fixtures

Real responses recorded on 2026-11-14 with `test/record-fixtures.ts` (Node 24 `fetch`). `test/fixture-context.ts` turns the transcript and Commons files into a `VideoContext`; the unit tests replay the LLM files through `replayFetch`.

## Clips

| Clip | Source | License |
|---|---|---|
| `nixon-armstrong-call` | [President Nixon speaking with astronauts Armstrong and Aldrin on the Moon.webm](https://commons.wikimedia.org/wiki/File:President_Nixon_speaking_with_astronauts_Armstrong_and_Aldrin_on_the_Moon.webm) (Richard Nixon Presidential Library), 202 s. Three voices: Houston CAPCOM, President Nixon, Neil Armstrong | Public domain (US federal government work) |
| `apollo11-small-step` | [Armstrong Small Step.ogg](https://commons.wikimedia.org/wiki/File:Armstrong_Small_Step.ogg) (NASA), 24 s, one voice. The same recording as `tests/fixtures/media/apollo11-small-step.mp3` | Public domain (NASA) |

Each clip was converted with `ffmpeg -vn -ac 1 -ar 16000 -b:a 32k` and sent as `audio/mpeg`. The audio is not committed; the recorder downloads it again.

## Files

| File | Request | Response |
|---|---|---|
| `nova3-nixon-armstrong-call.json` | Cloudflare Workers AI `POST /ai/run/@cf/deepgram/nova-3?diarize=true&smart_format=true&punctuate=true&utterances=true&paragraphs=true&detect_language=true` | 200, the Workers AI envelope around Deepgram's response: 28 utterances, speakers 0, 1 and 2, word timings and confidences, paragraphs. Deepgram misses part of Armstrong's reply (121 to 149 s) and hears "Oval Room" as "over room": that is what the service returned |
| `nova3-apollo11-small-step.json` | same | 200, 4 utterances, all speaker 0 ("That's one small step per van" is the recognizer's reading) |
| `commons-nixon-armstrong-call.json` | Wikimedia Commons `action=query&prop=imageinfo&iiprop=url\|size\|mime\|extmetadata` | 200, file record used for title, channel (Artist) and description. The Nixon Library's contact phone number and email address in the description are replaced with `[phone redacted]` and `[email redacted]` |
| `commons-apollo11-small-step.json` | same | 200 |
| `llm-nixon-armstrong-call.json` | `nameSpeakers` on the keyless chain (empty env); answered by OVH `gpt-oss-120b` | 200 chat completion. Names Speaker 2 "President Nixon" (confidence 0.97) with a quote at 54 s; Speakers 0 and 1 null. The body includes the model's reasoning text |
| `llm-nixon-armstrong-call--ovh-Meta-Llama-3-3-70B-Instruct.json` | same, recorder run with `llm/ovh/Meta-Llama-3_3-70B-Instruct` only | 200. Names Speaker 2 "Richard Nixon" (confidence 1) with a quote at 54 s |
| `llm-nixon-armstrong-call--pollinations-openai-fast.json` | same, recorder run with `llm/pollinations/openai-fast` only and `max_tokens` 4000 | 200 from `gpt-oss-20b` with `finish_reason: "length"`: the JSON stops after the second speaker's confidence. Kept with an `error` field; the test checks the `upstream` error and its hint. (At `max_tokens` 2000 the same rung answered 400 `output_token_limit_exceeded`, which is why the default is 4000) |
| `llm-apollo11-small-step.json` | `nameSpeakers` on the keyless chain; answered by OVH `Meta-Llama-3_3-70B-Instruct` | 200. Speaker 0 null, confidence 0 (the transcript never ties the voice to a name) |

Each `llm-*.json` file is `{ recordedAt, rung, error?, calls: [{ url, method, status, contentType, body }] }` with the body exactly as received; only the response's `content-type` header is kept. Request headers are not stored. No IP addresses, keys or account ids appear in any file (checked with grep, including against the Cloudflare account id).

The Workers AI transcription used about 1,600 neurons for the 202 s clip, inside the free daily allocation.
