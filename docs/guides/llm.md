# LLMs: the free chain, adding keys, OpenRouter and check:llm

vid2context uses an LLM to clean captions, name speakers, write briefs and answer questions. It works with no money and no keys: keyless lanes answer when nothing else is set up, and every free key you add gives it more rungs to fall back on.

## How the chain picks a rung

A rung is one service, one model and one key. Every LLM provider builds its rungs from env (no network), and the chain ([packages/core/src/chain.ts](../../packages/core/src/chain.ts)) orders the enabled ones:

1. **By tier**: `local` (your machine), then `free` (a hosted free tier with your key), then `keyless` (hosted, no account), then `paid` (only when its key is set).
2. **By priority inside a tier.** In the free tier: Groq, Cerebras, OpenRouter free-auto, NVIDIA, Kilo with a key, SambaNova, Cloudflare, Mistral, Zhipu, GitHub, Gemini, SiliconFlow, then Groq's small gpt-oss-20b. In the keyless tier: Kilo, OVH, Pollinations.
3. The first rung that answers wins. A rung that fails with a rate limit, a bad key or a retired model cools down for a while, so the next request skips it.

`VID2CONTEXT_POLICY=quality` orders by each model's quality score instead. `local-only` keeps everything on your machine. `VID2CONTEXT_SKIP=ovh,pollinations` drops services, and `VID2CONTEXT_KEYLESS=0` turns off every keyless lane (they send text to third parties without an account).

The rung list, with what each one needs, is in [docs/providers.md](../providers.md). `GET /api/v1/health` shows which rungs are enabled right now and which env vars the others need, never the values.

## Adding free keys

Put keys in `.env` (copy `.env.example`). Each one adds rungs with their own quota:

| Key | What it adds |
|---|---|
| `GROQ_API_KEY`, `CEREBRAS_API_KEY` | fast free tiers, one rung per model |
| `OPENROUTER_API_KEY` | the best live free model on OpenRouter |
| `NVIDIA_API_KEY` | Nemotron 3 Super on NVIDIA NIM |
| `SAMBANOVA_API_KEY` | Llama 3.3 70B |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | Llama 3.3 70B on Workers AI, 10,000 neurons a day |
| `MISTRAL_API_KEY`, `ZHIPU_API_KEY`, `GITHUB_TOKEN`, `GEMINI_API_KEY`, `SILICONFLOW_API_KEY` | more independent free quotas |
| `KILO_API_KEY` | raises the Kilo gateway limits (it works without one) |

Two env patterns work for every service:

- `<PROVIDER>_FALLBACK_KEYS=key2,key3` adds one rung per extra key (for example two free accounts). Keep `<PROVIDER>_API_KEY` a single key.
- `<PROVIDER>_MODEL=a,b` replaces that service's model list. Free model ids get retired; when a rung keeps failing with `not-found`, check the service's model list and set this.

For Cloudflare, a `CLOUDFLARE_FALLBACK_KEYS` entry can be `<account_id>:<token>` to pool a second account.

## OpenRouter

OpenRouter retires `:free` model ids without notice, so vid2context never pins one. The `llm/openrouter/free-auto` rung:

1. Reads the public model list (`GET https://openrouter.ai/api/v1/models`, no key needed) and keeps models that are free on both input and output, whose id ends in `:free`, that take and return text, and that have at least 32k tokens of context.
2. Ranks them by context length, how recent they are, and a small preference for strong open families (Gemma, Nemotron, Qwen, DeepSeek, Llama, Mistral, gpt-oss, GLM, Kimi). Models of under 7B parameters rank last.
3. Keeps that ranking in memory for an hour.
4. On each request it tries the best candidate. If that model is retired, rate limited or failing, it tries the next, up to three. A model that failed sits out for a while (30 minutes when retired). A bad key stops at once.

The answer reports the model that actually replied (`ChatResult.model`), so briefs can say which model wrote them.

`OPENROUTER_MODEL=vendor/model,...` adds one fixed rung per id. An id without `:free` is a paid rung, and the chain uses it only when paid rungs are allowed (`VID2CONTEXT_ALLOW_PAID` is not `0`).

## Checking what works today: `npm run check:llm`

```sh
npm run check:llm                        # every enabled rung, paid ones skipped
npm run check:llm -- --only llm/kilo     # by id prefix, service, provider or full id
npm run check:llm -- --skip ovh,pollinations
npm run check:llm -- --include-paid      # also call paid rungs (costs a little)
npm run check:llm -- --json              # machine-readable
npm run check:llm -- --timeout 30000 --concurrency 2
```

It sends every enabled rung one real request ("What is 17 plus 25? Reply with the number only.") and prints a table:

```
rung                                             tier     service     ms     correct  outcome
llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free  keyless  kilo        1080   yes      ok
llm/ovh/gpt-oss-120b                             keyless  ovh         45000  -        timeout: The operation was aborted due to timeout
```

- **ms**: time to the full answer.
- **correct**: `yes` when the answer is 42 and nothing else, `no` when the rung answered something else. A `no` usually means a model that ignores instructions or a broken answer parser. `-` means no answer.
- **outcome**: `ok`, or the error code and a short reason. `rate-limited-429`: the quota is used up for now (keyless lanes allow a few requests per minute). `auth-401`/`auth-403`: the key is wrong or lacks permission. `not-found-404`: the model id was retired, so set `<PROVIDER>_MODEL`. `upstream-5xx`: the service is having trouble. `timeout`: no answer within the timeout (free queues can be slow).

Rungs of the same service run one after another and up to four services run at once, so keyless hosts such as OVH (about 2 requests per minute per model) are not hammered. The exit code is 1 when no rung answered, so the command works as a health check in scripts. Keys are never printed: failure reasons are redacted.
