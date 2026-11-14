# Models: listing them and choosing one

vid2context does not have one model. It has a chain of rungs (one provider, one model, one credential each), tried free-first: local, then free tiers with your own key, then keyless hosts, then paid. This guide covers how the chain is shown to people as a list of models, and how a request picks one.

## Listing models

```ts
import { groupModels, listModels } from '@vid2context/core';

const models = listModels(registry, env, { kind: 'llm' }); // kind: 'llm' | 'stt' | 'embed' | 'video' | 'visual'; omit for all
const groups = groupModels(models); // [{ tier, services: [{ service, models }] }], for a picker
```

`listModels` reads env only (no network) and returns every rung the installed providers know, enabled or not, so people can see what a free key would unlock. Each entry is a `ModelInfo`:

| Field | Meaning |
|---|---|
| `id` | Rung id, e.g. `llm/groq/openai/gpt-oss-120b`. Send it back to choose this model. |
| `label` | The model id without vendor prefixes: `gpt-oss-120b`. |
| `service`, `provider`, `model` | Upstream service (`groq`, `ovh`; a pooled extra key is `groq#2`), the provider package, the exact model id. |
| `tier` | `local`, `free`, `keyless` or `paid`. |
| `quality` | 1 (rough) to 5 (best); the `quality` policy orders by it. |
| `capabilities` | Badges, below. |
| `contextTokens` | Context window on that tier, when known. |
| `enabled` | Whether the chain would use it now: its key is set, keyless lanes are allowed (`VID2CONTEXT_KEYLESS` is not `0`), paid is allowed (`VID2CONTEXT_ALLOW_PAID` is not `0`). |
| `requires` | Names of the env vars that enable it. Never their values. |

The list is sorted the way Auto tries rungs: tier (local, free, keyless, paid), then priority, then quality. Over HTTP the same list is `GET /api/v1/models?kind=llm`.

## Capability badges

| Badge | Meaning |
|---|---|
| `stream` | Answers stream token by token. Models without it still work in a chat UI; their answer arrives in one piece. |
| `json` | Can be asked for a JSON object (`response_format: json_object`). |
| `json-schema` | Strict structured output: the answer is held to a JSON Schema. |
| `tools` | Function calling. |
| `vision` | Accepts images. |

Speech-to-text rungs use their own words (`segments`, `words`, `diarization`, `translate`, ...); see [docs/contracts/providers.md](../contracts/providers.md).

## Choosing a model: Auto, pinned, strict

```ts
import { chatStream, resolveModelChoice } from '@vid2context/core';

const chain = resolveModelChoice(choice, registry, env);
for await (const ev of chatStream(registry, req, chain, ctx)) { /* meta, reasoning, delta, done */ }
```

| Choice | What happens |
|---|---|
| nothing (Auto) | The server's policy (`VID2CONTEXT_POLICY`, `free` by default) over the whole chain. This is the default and the cheapest. |
| `{ policy: 'free' \| 'quality' \| 'local-only' }` | That policy over the whole chain. `local-only` never leaves the machine. |
| `{ rung: '<id>' }` (pinned) | Start with that model. If it fails before the first token (rate limit, outage, not enabled), the chain carries on in its normal order. |
| `{ rung: '<id>', strict: true }` | That model or an error. Choosing a strict model that is not enabled is rejected up front, with the env var names that would enable it. |

An unknown id or policy is a `bad-request` error whose hint points at `/models`.

## What the stream looks like

`chatStream` yields `meta` (the rung that is answering), then `reasoning` (only when the model shows its thinking), then `delta` events with the answer, then one `done` with the full text, usage and every attempt. If the first rung fails before answering, the next one is tried and `meta` names the one that answered. Once answer text has started, the stream never switches models: a failure ends it with an error listing the attempts, so a reply never mixes two models.
