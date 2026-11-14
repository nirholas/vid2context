# LLM fixtures

Real chat completion responses recorded on 2026-11-14 from the keyless lanes, no key sent.

| File | Endpoint and model | Notes |
|---|---|---|
| `ovh-llama-3.3-70b.json-object.json` | OVH `Meta-Llama-3_3-70B-Instruct`, `response_format: json_object` | JSON answer |
| `ovh-gpt-oss-120b.json` | OVH `gpt-oss-120b` | answer in `content`, chain of thought in `reasoning`; the answer uses a narrow no-break space (U+202F) |
| `ovh-gpt-oss-120b.empty-length.json` | OVH `gpt-oss-120b`, `max_tokens: 5` | no `content`, `finish_reason: length`: the budget went to reasoning |
| `pollinations-openai-fast.json-object.json` | Pollinations `openai-fast` (serves gpt-oss-20b), `json_object` | JSON answer plus `reasoning` |

The prompt for all of them: "Which year did Apollo 11 land on the moon?" (with "Use keys year and mission." for the JSON ones).
