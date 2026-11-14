# Chapters fixtures

Real LLM responses recorded on 2026-11-14 from this repo's VM by `scripts/record.ts` (`LIVE=1 node_modules/.bin/tsx packages/chapters/scripts/record.ts`), through the testkit recorder, which scrubs keys and IP addresses. The input is the shared fixture `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (18 minutes, no chapters). Tests replay them in recorded order.

| File | Source |
|---|---|
| `llm-titles-001.json` | OVH keyless `Meta-Llama-3_3-70B-Instruct`: HTTP 429 `API rate limit exceeded` (2 requests per minute per IP), so the chain moved on |
| `llm-titles-002.json` | OVH keyless `gpt-oss-120b`: titles for the 4 offline chapters, 2 boundaries moved within the 45 s window |
| `llm-summaries-001.json` | Pollinations keyless `openai-fast` (gpt-oss-20b): titles plus one or two sentence summaries for the same 4 chapters |

The request bodies hold the public transcript of the video and the prompt; nothing personal. The fence token in each prompt is random per call, so tests compare prompts with that token masked.
