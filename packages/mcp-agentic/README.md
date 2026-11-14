# @vid2context/mcp-agentic

The MCP features that let the vid2context server work with the client instead of only answering it: sampling, elicitation, completions and resource subscriptions. Nothing here calls a hosted LLM: sampling uses the client's own model, so the user needs no key.

## Mounting

```ts
import { registerAgenticFeatures } from '@vid2context/mcp-agentic/mcp';

const server = createServer(registry, ctx); // packages/mcp
registerAgenticFeatures(server, { registry, ctx, storage: (c) => registry.openStorage(c) });
await server.connect(transport);
```

Call it before `connect`. It declares the `resources.subscribe` and `completions` capabilities, and MCP fixes capabilities at initialization: the SDK throws if you register them after a transport is connected. There is no transport code, so the same call serves stdio and Streamable HTTP. With Streamable HTTP, create one server per session (the SDK binds one transport to one server); subscriptions are tracked per server, which makes them per session.

`storage` is the cache and library. When omitted, the registry's enabled storage backend is opened once on first use.

This package handles `resources/subscribe` and `resources/unsubscribe` for every `vid2context://` URI. If the base server (item 44) also wants subscriptions for its own resources, it should use `notifyResourceUpdated(server, uri)` from here rather than registering a second handler (the SDK allows only one per method, and `registerAgenticFeatures` throws if one exists).

## What each feature does

| Feature | Name | What it does | Without client support |
|---|---|---|---|
| Sampling | tool `digest_videos { urls?, collection?, question?, maxTokensPerVideo? }` | Map: one `sampling/createMessage` per transcript chunk asks the client's model for bullet notes, each ending in `[m:ss]`. Reduce: one more call combines the notes into a digest that cites `[Title @ m:ss]`, answers `question`, and flags where sources agree and disagree. | Returns a chunk plan (videos, chunks with time ranges and token estimates, the `get_section` call for each, and the exact map and reduce instructions) so the agent does the same work itself. Never an error. |
| Elicitation | tool `choose_caption_track { url }` | Lists the caption tracks through the captions provider's `listTracks`; with more than one, asks the user to pick (a titled enum: "English", "German", "English (auto-generated)"), then returns that transcript with the same header as `get_transcript`. One track: returned without asking. | Returns the track list and the `get_transcript` call with `language`. Declined or dismissed: the track list. |
| Elicitation | `confirmExpensive(server, { message, estimateMinutes, env?, extra? })` | For other tools, before slow or costly work. Returns `accept` below `VID2CONTEXT_CONFIRM_STT_MINUTES` (default 20) without asking; above it asks yes or no. | `unsupported`, and the caller decides. |
| Completions | prompt `digest { collection?, urls?, question? }` | `collection` completes collection ids and names; `urls` completes saved video ids and titles (case-insensitive prefix, at most 20; in a comma-separated list the last item is completed). The template `vid2context://collection/{id}/latest` completes `id`. The prompt's messages tell the agent to call `digest_videos` and how to handle a chunk plan. | Clients without completion UI still get the prompt. |
| Subscriptions | resource `vid2context://collection/{id}/latest` | The 20 most recently added videos of a collection as JSON. `notifyCollectionUpdated(server, id)` sends `notifications/resources/updated` to that server's client if it subscribed; `notifyCollectionUpdated(id)` does it for every subscribed session in the process. Both URIs `.../{id}/latest` and `.../{id}` are notified. | Clients can still read the resource. |

Helpers for item 44: `completeCollections(storage, prefix)`, `completeVideos(storage, prefix)`, `completeListItem(value, complete)`, `confirmExpensive`, `notifyResourceUpdated`, and the citation checks (`checkNotes`, `checkDigest`, `invalidCitations`).

## How digest_videos keeps citations honest

- Chunking: chapters are natural boundaries (small chapters are packed together, a chapter over budget is cut into even time windows); without chapters the transcript is cut into even time windows. Each chunk holds at most `maxTokensPerVideo` estimated tokens (default 6000, `estimateTokens` from core: about 4 characters per token). Every line keeps its `[m:ss]` marker.
- Every timestamp the model writes must lie inside the video's duration, inside the chunk it was shown (for notes), and within 5 seconds of a real transcript segment. A line with a failing timestamp is dropped; the result says how many lines were dropped and lists them with the reason.
- The model writes `[Title @ m:ss]` only. The server rewrites each verified citation to `[Title @ m:ss](deep link)` with `timestampUrl`, so the model never has to produce URLs.
- Map calls run three at a time (some clients serialize sampling anyway). Progress notifications go out per chunk when the client sends a progress token, and cancellation stops new calls. If the user rejects one sampling request, the rest are not sent. If the combine call fails, the verified notes per video are returned instead.
- Model preferences: map calls favour cost and speed (`costPriority` 0.9, `speedPriority` 0.8); the single reduce call favours capability (`intelligencePriority` 0.7).
- Notes are compact (5 to 15 bullets per chunk), so a 15-episode series of 30-minute videos (about 45 chunks) reduces to roughly 25k tokens of notes in one combine call. There is no second reduce level yet for collections far beyond that.

## Client support and protocol version

Built on `@modelcontextprotocol/sdk` 1.32.2, the newest release on 2026-11-14, which speaks protocol `2025-11-25`. Verified here: the official TypeScript SDK `Client` (used by the tests) supports all four features when the host implements the sampling and elicitation handlers. Which desktop and web clients (Claude Code, Claude Desktop, VS Code, Cursor, ChatGPT) declare `sampling` and `elicitation` today was not verified; check the client's `initialize` capabilities.

Every feature degrades cleanly: a client that declares no `sampling` gets the chunk plan; no `elicitation` gets the track list or `unsupported`.

Spec `2026-07-28` changes this ground: it deprecates Sampling (still functional for at least twelve months), replaces server-initiated `sampling/createMessage` and `elicitation/create` with Multi Round-Trip Requests (`input_required` results the client answers on a retry), and replaces `resources/subscribe` with `subscriptions/listen`. The SDK does not implement that revision yet. When it does, the chunk plan stays the path for clients without sampling, elicitation moves to `inputRequests`, and the subscription tracking moves to `subscriptions/listen`.

## Tests

`npx vitest run packages/mcp-agentic` connects a real SDK `Client` to a server with these features over `InMemoryTransport`. The client's sampling handler is the real vid2context LLM chain (`chat()` from core); unit tests replay chat completions recorded from the keyless OVH and Pollinations lanes (see `test/fixtures/README.md`). `LIVE=1` runs the digest against the real keyless chain.

Re-record the fixtures with `npx tsx packages/mcp-agentic/test/record-fixtures.ts` whenever the prompts in `src/prompts.ts` or the chunking change, since replay matches the exact messages.
