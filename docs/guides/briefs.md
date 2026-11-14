# Cited briefs and structured extraction

`@vid2context/insights` turns one or many videos into a cited brief (Markdown plus JSON) or into structured JSON that matches a template or your own JSON Schema. Every claim points at a video, a timestamp and a quote, and the quote was checked against the transcript before the claim was allowed in.

## Who writes the brief

There are two paths. Both use the same sources, citation rule and templates.

| | Agent-side (default) | Server-side |
|---|---|---|
| Who synthesizes | The calling agent, with its own model | vid2context, through the core LLM chain |
| Cost | Nothing extra | Free-first: local LLM, then free tiers with your key, then keyless hosts; paid only when its key is set |
| API | `briefPrompt(contexts, opts)`, `extractPrompt(contexts, opts)`, `briefInstructions()`, `buyerGuideInstructions(product)` | `buildBrief(contexts, opts, deps)`, `extract(contexts, opts, deps)` |
| Surfaces | MCP prompts `brief` and `buyer_guide` (item 44 imports the text) | MCP tools `build_brief`, `extract`; HTTP `POST /briefs`, `POST /extract` |
| Use when | The sources fit the agent's context (about 12k tokens per hour of speech) | A collection is too large for the agent, or the agent's model is weak |

`briefPrompt` returns chat messages: a system prompt, then the instructions, the citation rule (`[Video title @ m:ss](timestamp link)`), the agreement rules (consensus needs two or more videos, disagreements cite both sides, single-source claims are labelled) and the sources. Each source is a fenced untrusted block (`fenceUntrusted` from core) holding its title, channel, length, a timestamp link template and timestamped transcript lines. With `maxTokens`, sources that do not fit are listed by id with a note to fetch them with `get_outline`, `get_section` or `search_transcript`, never dropped silently.

## Server-side: single pass or map-reduce

```ts
import { buildBrief } from '@vid2context/insights';
const brief = await buildBrief(contexts, { question: 'Which G-Wagon should I buy?', template: 'buyer-guide' }, { registry, ctx });
console.log(brief.markdown);
```

1. Budget. The source budget per call comes from the first rung the chain would try: 75 percent of its `contextTokens`, minus the answer and the prompt, capped at 24k tokens (keyless hosts are slow on huge prompts). `maxChunkTokens` lowers it.
2. Single pass. When every source fits, one call returns the claims and their organization into topics and points.
3. Map. Otherwise each video is cut at line boundaries (lines are about 10 s of segments) into chunks that fit, and each chunk becomes claims JSON: `{ claim, quote, videoId, startSec, topic, stance? }`.
4. Verify. Every claim's quote is checked against its transcript (rules below). Only verified claims go on.
5. Reduce. Claims are grouped by normalized topic (lowercase, stop words and simple plurals folded) and packed into batches; an LLM merges topics that mean the same thing and groups claims into points with `support`, `oppose` and a `counter` sentence. By default the reduce step uses policy `quality` (unless you set a policy), so it prefers the strongest rung you have.
6. Classify, in code, never by the model: a point is `consensus` when its supporting claims come from two or more distinct videos and nothing opposes it, `disagreement` when claims sit on both sides, `single-source` otherwise. Verified claims that no point mentions become single-source points, so nothing verified is lost.

Calls run one at a time, so keyless lanes stay under their per-minute limits. When every rung is rate-limited, the call waits about a minute (a little over the chain's cooldown) and retries, up to `rateLimitRetries` times (default 3). The result records which rung served each step (`rungs`) and every attempt (`attempts`). Steps that failed without sinking the whole run are listed in `notes` and in the Markdown.

## Citation verification

`verifyCitations(claims, contexts)` and `verifyQuote(context, quote, startSec)`:

- Quote and transcript are normalized the same way: lowercase, no diacritics, no punctuation, apostrophes joined (`you're` becomes `youre`), whitespace collapsed. Auto-captions have no case or punctuation, so this is the only fair comparison.
- A quote needs at least 4 words (`MIN_QUOTE_TOKENS`); shorter ones match almost anywhere and prove nothing.
- The window is every segment overlapping `startSec` plus or minus 30 s (`WINDOW_SEC`), extended by the quote's own length.
- Score: a span of `ceil(1.25 x quote words)` transcript words slides over the window; the score is the best count of quote words found in the span (order ignored) divided by the quote's word count. A claim passes at 0.8 (`THRESHOLD`) or more. An exact quote scores 1.0; a quote with about one word in five changed or misheard still passes; a paraphrase in different words fails.
- On a pass, `startSec` is snapped to the start of the segment holding the first matched word, and `endSec` to the end of the segment holding the last. The link comes from core `timestampUrl`.
- On a fail, the whole transcript is searched. A quote found at another time is rejected as `quote-at-other-time` (with `foundAtSec`), because the model mixed up its sources; otherwise `quote-not-found`. Other reasons: `unknown-video`, `no-quote`, `quote-too-short`, `bad-timestamp`.

Unverified claims never appear as cited. They are listed in `unverified` and in the brief's appendix with the reason.

## Templates

| Id | What it extracts |
|---|---|
| `brief` | Title, summary, and cited points by topic |
| `buyer-guide` | Product, summary, models and trims (with years and verdict), model years to seek, consider or avoid, prices, known problems (what they affect, severity), what to avoid, mileage advice, questions for the seller; each item cited |
| `tutorial-steps` | Goal, prerequisites, ordered steps with exact values, pitfalls |
| `comparison` | Columns (criteria), rows (options) with cited cells, and a cited verdict |
| `summary` | One paragraph and cited key points (the `extract` default) |

Each template is a TypeScript module in `packages/insights/src/templates/` holding its Markdown prompt text (`instructions`), its preferred topics and its JSON Schema. They are modules rather than `.md` files read at runtime so the package runs unchanged on Workers and in the browser.

In template results, each item has `sources`: a list of `{ videoId, startSec, quote }`. After verification each one becomes a full citation (`videoId`, `title`, snapped `startSec`, `endSec`, `url`, `quote`); failed ones are removed and listed in `unverified` with their JSON pointer, and an item whose citations all failed is removed with them.

## Custom JSON Schemas

`extract(contexts, { schema })` accepts this subset: `type` (one or a list), `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, plus annotations (`title`, `description`, `default`, `examples`, `format`, ...). Anything else (`$ref`, `anyOf`, `oneOf`, `allOf`, `not`, `if`, `patternProperties`, tuple `items`) fails at once with `bad-request` and a hint. The validator is built in (no ajv), so it runs everywhere.

The model answers `{ data, citations }`: `data` matches your schema and each citation names the JSON pointer it supports. The answer is validated; on failure exactly one repair call sends the errors back. If the repaired answer still fails, the call fails with `upstream` and a hint. Your `data` is returned as the model wrote it (a custom schema cannot be pruned safely), so the result adds `uncited`: the pointers of values no verified citation covers. Treat those as unsupported by the videos.

## HTTP and MCP

- `insightsRoutes(deps)` from `@vid2context/insights/http` serves `POST /briefs` and `POST /extract` (mounted under `/api/v1` by the server). With `deps.queue` (a `@vid2context/jobs` queue) they answer `202 Job` of kind `brief` or `extract` and register those kinds on the queue; without one they answer `200` with the result. Bodies are validated before anything is queued. Every runner of a deployment must call `registerInsightsJobs(queue)`.
- `registerInsightsTools(server, deps)` from `@vid2context/insights/mcp` registers `build_brief` (Markdown by default, `format: "json"` for the full `Brief`) and `extract`.

## Walkthrough: which G-Wagon to buy

WALKTHROUGH
