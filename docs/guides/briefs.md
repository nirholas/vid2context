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
2. Single pass. When every source fits, one call returns the claims and their organization into topics and points. It does the reduce step's work, so it runs on the reduce chain (policy `quality` by default).
3. Map. Otherwise each video is cut into chunks that fit by core `chunkTranscript` (sentence ends and pauses first, whole segments otherwise, so a quote is rarely split between chunks), and each chunk becomes claims JSON: `{ claim, quote, videoId, startSec, topic, stance? }`.
4. Verify. Every claim's quote is checked against its transcript (rules below). Only verified claims go on.
5. Reduce. Claims are grouped by normalized topic (lowercase, stop words and simple plurals folded) and packed into batches; an LLM merges topics that mean the same thing and groups claims into points with `support`, `oppose` and a `counter` sentence. By default the reduce step uses policy `quality` (unless you set a policy), so it prefers the strongest rung you have.
6. Classify, in code, never by the model: a point is `consensus` when its supporting claims come from two or more distinct videos and nothing opposes it, `disagreement` when claims sit on both sides, `single-source` otherwise. Verified claims that no point mentions become single-source points, so nothing verified is lost.

A model answer that is not a JSON object is retried on the next rung, up to three rungs (`JSON_ATTEMPTS`). Free rungs often stop at their output limit in the middle of a long answer; when no rung returns a whole object, the longest cut-off answer is used for the claims it finished (`salvageTruncatedJson`), and `notes` says so. If nothing usable comes back, the single pass fails with `all-rungs-failed` and the attempts, instead of returning an empty brief.

Calls run one at a time, so keyless lanes stay under their per-minute limits. When every rung is rate-limited, the call waits about a minute (a little over the chain's cooldown) and retries, up to `rateLimitRetries` times (default 3). The result records which rung served each step (`rungs`) and every attempt (`attempts`). Steps that failed without sinking the whole run are listed in `notes` and in the Markdown.

## Citation verification

`verifyCitations(claims, contexts)` and `verifyQuote(context, quote, startSec)`:

- Quote and transcript are normalized the same way: lowercase, no diacritics, no punctuation, apostrophes joined (`you're` becomes `youre`), whitespace collapsed. Auto-captions have no case or punctuation, so this is the only fair comparison.
- A quote needs at least 4 words (`MIN_QUOTE_TOKENS`); shorter ones match almost anywhere and prove nothing.
- The window is every segment overlapping `startSec` plus or minus 30 s (`WINDOW_SEC`), extended by the quote's own length.
- Score: a span of `ceil(1.25 x quote words)` transcript words slides over the window; the score is the best count of quote words found in the span (order ignored) divided by the quote's word count. A claim passes at 0.8 (`THRESHOLD`) or more. An exact quote scores 1.0; a quote with about one word in five changed or misheard still passes; a paraphrase in different words fails.
- Quotes longer than 40 words (`MAX_QUOTE_WORDS`) are cut to their first 40 words before the check, and the cut quote is what the citation keeps. Free models sometimes copy minutes of transcript as one "quote"; a citation should point at one moment.
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

Each template's prompt text is a Markdown file, `packages/insights/src/templates/<id>.md`; its id, title, preferred topics and JSON Schema live in `<id>.ts` next to it. The package never reads files at runtime (it must run unchanged on Workers and in the browser), so `scripts/embed-templates.mjs` embeds the `.md` files into `src/templates/prompts.generated.ts`, the same pattern as the Postgres migrations. After editing a prompt, run `node packages/insights/scripts/embed-templates.mjs`; `test/templates.test.ts` fails while the generated module and the `.md` files differ.

In template results, each item has `sources`: a list of `{ videoId, startSec, quote }`. After verification each one becomes a full citation (`videoId`, `title`, snapped `startSec`, `endSec`, `url`, `quote`); failed ones are removed and listed in `unverified` with their JSON pointer, and an item whose citations all failed is removed with them.

## Custom JSON Schemas

`extract(contexts, { schema })` accepts this subset: `type` (one or a list), `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, plus annotations (`title`, `description`, `default`, `examples`, `format`, ...). Anything else (`$ref`, `anyOf`, `oneOf`, `allOf`, `not`, `if`, `patternProperties`, tuple `items`) fails at once with `bad-request` and a hint. The validator is built in (no ajv), so it runs everywhere.

The model answers `{ data, citations }`: `data` matches your schema and each citation names the JSON pointer it supports. The answer is validated; on failure exactly one repair call sends the errors back. If the repaired answer still fails, the call fails with `upstream` and a hint. Your `data` is returned as the model wrote it (a custom schema cannot be pruned safely), so the result adds `uncited`: the pointers of values no verified citation covers. Treat those as unsupported by the videos.

## HTTP and MCP

- `insightsRoutes(deps)` from `@vid2context/insights/http` serves `POST /briefs` and `POST /extract` (mounted under `/api/v1` by the server). With `deps.queue` (a `@vid2context/jobs` queue) they answer `202 Job` of kind `brief` or `extract` and register those kinds on the queue; without one they answer `200` with the result. Bodies are validated before anything is queued. Every runner of a deployment must call `registerInsightsJobs(queue)`.
- `registerInsightsTools(server, deps)` from `@vid2context/insights/mcp` registers `build_brief` (Markdown by default, `format: "json"` for the full `Brief`) and `extract`.

## Walkthrough: which G-Wagon to buy

Four parts of the Alliance Motorworks G-Wagon buyer's series (about 23k tokens of transcript, so one pass), question "Which G-Wagon should I buy: model, year range and mileage, and what should I check before buying?", buyer-guide template, no keys set. This is the recorded run in `packages/insights/test/fixtures/llm/brief-single.json`; rerun it live with `npx tsx packages/insights/examples/brief.ts`.

What happened, from `rungs` and `attempts`: the single pass runs on the reduce chain (policy `quality`), so gpt-oss-120b on OVH went first. It spent its whole 4000-token output budget on reasoning and returned empty content (`finish_reason: length`), so the chain moved on to Llama 3.3 70B, which answered in 34 s. Llama wrote timestamps as `[55]`, copying the line tags; `parseSeconds` accepts that form. It proposed 10 claims: 7 passed verification and 3 did not. Excerpt of the Markdown:

```md
## Engines

- The 2000 G500 has a reliable M113 V8 engine
  - [Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked! @ 1:09](https://www.youtube.com/watch?v=cCPsdFdlshc&t=69s): "this one has what we know the legendary m113 V8"
- The 2012 G55 AMG has a supercharged engine with 490 horsepower
  - [Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked! @ 4:47](https://www.youtube.com/watch?v=cCPsdFdlshc&t=287s): "491 horsepower of German ponies"

## Maintenance costs

- The cost of maintaining a G-Wagon is comparable to other German vehicles
  - [G-Wagon Mechanic Reveals The Truth: Are They Ridiculously Expensive To Maintain? @ 10:07](https://www.youtube.com/watch?v=ovIkN7UgbgE&t=607s): "you're going to pay more for is labor"

## Appendix: unverified claims

| Claim | Video | Reason |
|---|---|---|
| The G55 AMG is a good choice for someone who wants a lot of power and fun | youtube:cCPsdFdlshc @ 8:57 | quote-not-found: Best match near 8:57 covers 78% of the quote's words (needs 80%). |
| The G-Wagon is not ridiculously expensive to maintain | youtube:ovIkN7UgbgE @ 8:27 | quote-not-found: Best match near 8:27 covers 57% of the quote's words (needs 80%). |
```

Two things to notice. Every link opens the video where the quoted words are spoken: the model said 0:55 for the M113 quote, and verification moved it to 1:09, where the words start. And the claim about the G55 is in the appendix, not the brief, because the model's quote was only 78 percent the transcript's words.

The run also shows the limits of the keyless fallback. With 10 claims and no claim made by two videos, the brief has no consensus points, and Llama filed fuel economy under "Prices". A local model or a free-tier key (`docs/providers.md`) gives the single pass a stronger first rung; agent-side synthesis with `briefPrompt` uses whatever model the agent runs.

## Live run and hand spot-check (2026-11-15)

`npx tsx packages/insights/examples/brief.ts` over the same four videos, keyless chain only (the Cloudflare token in this VM's `.env` was rejected that day, so no free-tier rung took part). From `rungs` and `attempts`: Kilo's Nemotron Ultra and Nemotron Lightning answers both stopped mid-JSON at their output limit, gpt-oss-120b on OVH spent its budget on reasoning, and the third JSON attempt, Llama 3.3 70B on OVH, answered. 20 claims were proposed: 13 passed verification, 7 did not (5 quotes matched 31 to 57 percent of the transcript words near their time, 2 quotes were one or two words long). An earlier run the same day, before quotes were capped at 40 words, kept the finished claims of a cut-off Nemotron answer (15 verified, with quotes up to 710 words; that is why the cap exists).

Five citations from that run, checked by hand: each link was opened as a reader would (the video id from `v`, the second from `t`; both videos answer YouTube's oEmbed with 200, so the links resolve) and the transcript read from that second on.

| Claim | Link | Transcript from that second |
|---|---|---|
| The 2000 G500 has the legendary M113 V8 engine | [cCPsdFdlshc @ 1:09](https://www.youtube.com/watch?v=cCPsdFdlshc&t=69s) | [69.36] "to this one has what we know the" [71.12] "legendary m113 V8 this was Mercedes big". Quote: "this one has what we know the legendary m113 V8". Match. |
| The G55 AMG drinks a little oil as it ages | [cCPsdFdlshc @ 5:02](https://www.youtube.com/watch?v=cCPsdFdlshc&t=302s) | [302.24] "little oil they drink a little oil as" [303.64] "they age one thing you will note on". Quote: "they drink a little oil as they age". Match. |
| The 2018 G550 gets 14.2 miles per gallon | [1Xx1fmHIsiA @ 2:34](https://www.youtube.com/watch?v=1Xx1fmHIsiA&t=154s) | [154.20] "The last 14,000 miles that we've driven, averaging 14.2 miles a gallon." Quote: "averaging 14.2 miles a gallon". Match. |
| The tailgate can close on its own in high winds | [1Xx1fmHIsiA @ 10:38](https://www.youtube.com/watch?v=1Xx1fmHIsiA&t=638s) | [638.04] "thing that is a little annoying is if in real high wind, this will close on you." Quote: "This will close on you". Match. |
| The trunk space is massive | [1Xx1fmHIsiA @ 10:42](https://www.youtube.com/watch?v=1Xx1fmHIsiA&t=642s) | [642.96] "So but what I will say, these trunks are massive, like absolutely massive." Quote: "these trunks are massive, like absolutely massive". Match. |

All five open on the quoted words. What verification does not check is whether the claim says what the quote says: in the same run, "The 2015 G550 has a 4.0L twin-turbo V8 engine" carries the verified quote "this is the m278 dual overhead cam naturally aspirated V8" (at 9:40), which contradicts it. The quote and link are honest, the model's summary of them is not. Read the quote, not only the claim.

The same check runs automatically in `packages/insights/test/live.test.ts` (`LIVE=1`): a buyer guide over parts 1 and 3 on the keyless chain, then every citation link is resolved independently of `verify.ts` (video by `v`, transcript from `t` for a minute) and must contain at least 80 percent of the quote's words.
