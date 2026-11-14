# Ask fixtures

Real exchanges with the keyless LLM lanes, recorded on 2026-11-14 by `npx tsx packages/ask/test/record-fixtures.ts` with an empty env (no key sent, so only OVH AI Endpoints and Pollinations run). Each file lists every request the engine made, in order: URL, the `model` from the request body, status, the `content-type` and `retry-after` headers, and the body. Answers are native SSE streams (`text/event-stream`). A request that got no response is stored with status 0 and the error name (`TimeoutError`) and replayed by rejecting with it. Nothing personal is in them: no key, no IP, only opaque upstream request ids.

The grounding transcripts are the shared real fixtures `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (G-Wagon buyer's guide) and `youtube-jNQXAC9IVRw.json` (Me at the zoo).

| File | What was asked | Exchanges |
|---|---|---|
| `gwagon-g55.json` | "How much horsepower does the G55 AMG compressor engine make, and does it have any known issues?" over the G-Wagon video (whole transcript fits) | OVH Llama 3.3 70B, 200 |
| `gwagon-offtopic.json` | "What is the towing capacity of the electric G580?" (not covered by the video) | OVH Llama 3.3 70B, 200 |
| `gwagon-followup.json` | follow-up "How much power does it make?" after "Which engine does the 2000 G500 use?", chunked mode (`maxSourceTokens` 1200) | condense call then answer, both OVH Llama 3.3 70B, 200 |
| `collection-na-offroad.json` | "Why did they pick a naturally aspirated G550 for an off-road build instead of a biturbo?" over a collection of both videos, chunked mode (`maxSourceTokens` 1500) | OVH Llama 3.3 70B, 200 |
| `chat-sse-designo.json` | `POST /chat` "Which years have the designo seats?" over the G-Wagon video | OVH Llama 3.3 70B timed out after 120 s (status 0, `TimeoutError`), then OVH gpt-oss-120b, 200 (reasoning stream; cites with its native lenticular-bracket markers) |
| `strict-429.json` | "What does the 2000 G500 interior look like?" with `model: { rung: 'llm/ovh/Meta-Llama-3_3-70B-Instruct' }`, after rate-limiting that model on purpose with unrecorded calls | OVH Llama 3.3 70B, 429; then OVH gpt-oss-120b, 200 |
| `all-429.json` | "Which years have timing chains?" with `VID2CONTEXT_SKIP=pollinations`, after rate-limiting both OVH models on purpose with unrecorded calls | OVH Llama 3.3 70B, 429; OVH gpt-oss-120b, 429 |
