# @vid2context/mcp-apps

An interactive transcript viewer that renders inside the chat in hosts that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (the MCP extension that ChatGPT and Claude both render). One tool, one UI resource:

| | |
|---|---|
| Tool | `open_transcript_viewer { url, language? }` |
| UI resource | `ui://vid2context/transcript-viewer`, mime type `text/html;profile=mcp-app` |
| Spec version | MCP Apps 2026-01-26, as implemented by `@modelcontextprotocol/ext-apps` 1.7.x (the line that works with `@modelcontextprotocol/sdk` 1.x used by `packages/mcp`) |

## What the viewer does

- Header with title, channel, duration, transcript origin and line count.
- Chapter list (when the video has chapters) that jumps to the chapter's first line and marks the chapter you are reading.
- Full-text search with highlighted hits, a hit counter and next/previous (Enter, Shift+Enter).
- Every line starts with `[m:ss]`. Clicking it opens the video at that moment through the host's `ui/open-link`; when the host has no open-link capability or refuses, the plain link opens instead.
- A "Cite" button per line copies `[Title @ m:ss](url)`.
- Select lines (checkbox, Shift-click or Shift+arrows) to copy a citation for the range or, when the host accepts `ui/message`, "Send to chat" posts the lines with timestamps and a citation as a user message.
- Light and dark themes from the host's `theme` hint and style variables (dark by default, the shared vid2context tokens as fallback). "Expand" asks for fullscreen when the host offers it.
- Keyboard: arrow keys, Page Up/Down, Home/End move between lines (one tab stop for the list), Enter opens the moment, C copies a citation, Space selects, `/` jumps to search, Escape clears. Visible focus rings, ARIA labels on every control, readable at 360 px.
- Windowed rendering: only the lines near the visible area exist in the DOM (at most 90), so an hour-long transcript (about 1,500 lines) stays fast.

The tool always returns:

- `structuredContent`: `{ metadata, chapters, segments, timestampBase }`. Segments are `[startSec, endSec, text]` tuples with the raw transcript text. `timestampBase` is a link template with `{t}` for whole seconds (null for local files).
- Text content: the usual `contextHeader` (title, channel, URL, duration, origin, chapters) plus the transcript. When the client declared MCP Apps support (`capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes` contains `text/html;profile=mcp-app`) the text is capped at about 4,000 characters with a note that the full transcript is in the viewer; any other client gets the full timestamped transcript, so the same call is still useful without a UI.

Note that ChatGPT shows `structuredContent` to the model as well as to the viewer, which is why segments are compact tuples and the metadata is trimmed.

## How it is built

The viewer is plain TypeScript and DOM code in `src/ui/` (`viewer.ts` renders, `bridge.ts` speaks the MCP Apps protocol, `main.ts` wires them, `styles.css` holds the shared design tokens). `scripts/build-viewer.mjs` bundles it with esbuild into one HTML document (about 27 KB, inline CSS and JS, no external URLs) and writes `src/ui/viewer.html.ts`, which is committed so the package still exports source with no build step. After changing anything in `src/ui/`, run:

```sh
node packages/mcp-apps/scripts/build-viewer.mjs
```

`test/bundle.test.ts` fails when the committed file is stale.

The view side of the protocol is a small client (`src/ui/bridge.ts`) rather than the ext-apps `App` class: `App` validates messages with zod v4, which puts all of zod and its locales into the page (about 580 KB, plus library strings such as JSON Schema dialect URLs). The client sends and handles the same messages, typed from ext-apps, and `test/bridge.test.ts` runs it against the ext-apps `AppBridge` host implementation, which validates every message against the spec schemas. The server side uses the ext-apps helpers (`registerAppTool`, `registerAppResource`, `getUiCapability`).

## Supported hosts

Verified:

- The ext-apps `AppBridge` host implementation, in `test/bridge.test.ts` and `test/host.test.ts` (the built HTML in an iframe, driven over postMessage).
- Headless Chromium (Playwright) with the built HTML in a `sandbox="allow-scripts"` iframe under the spec's default CSP, driven by `AppBridge` as host: the handshake, tool result, search, a timestamp click arriving as `ui/open-link`, "Send to chat" arriving as `ui/message`, size reports, and light and dark themes at 360 px and 900 px wide, with no console errors. This was a one-off check on 2026-11-14, not a committed test.

- The ext-apps `basic-host` reference host (tag v1.7.5) in headless Chromium, on 2026-11-15, end to end: `createServer()` served by `packages/mcp-http` with a bearer token, `basic-host` connected over Streamable HTTP, `open_transcript_viewer` called on `https://www.youtube.com/watch?v=cCPsdFdlshc` through the real pipeline. The host read the resource, loaded it through its sandbox proxy with `clipboard-write` granted, and the viewer showed the header, 9 chapters and the windowed transcript (17 line elements for 347 lines). Search highlighted hits, a timestamp click arrived as `ui/open-link` and the host opened `...&t=302s`, checking two line boxes selected the range between them, "Send to chat" arrived as `ui/message` (with `message` added to the host's declared capabilities, which stock `basic-host` leaves out, so the viewer correctly hides the button there), the host theme toggle switched the viewer to dark, and at 360 px nothing scrolled sideways. No page errors. Not a committed test: it needs the network and a browser.

Not verified live: ChatGPT (developer mode), Claude, VS Code and Goose render MCP Apps per their docs, but none was reachable from the build machine. See "Trying it in a real host" below.

## How item 44 mounts it

```ts
// packages/mcp/src/server.ts, inside createServer(registry, ctx)
import { registerAppsTools } from '@vid2context/mcp-apps/mcp';
registerAppsTools(server, { registry, ctx });
```

`registerAppsTools` opens the configured storage backend once (`registry.openStorage(ctx)`) and uses it as the pipeline cache, and gives each call its own `Ctx` with the call's abort signal. It imports `contextHeader` and `toolError` from `@vid2context/mcp`, so the two packages depend on each other; that is safe because nothing in either module runs the other's exports at load time.

## How item 45 exposes it to ChatGPT

Nothing extra is needed beyond serving `createServer()` over Streamable HTTP at a public HTTPS URL: the tool's `_meta.ui.resourceUri` and the resource's `text/html;profile=mcp-app` content are what ChatGPT and Claude read. Points to check:

- The viewer needs no network access, so the resource declares no `ui.csp` domains (hosts apply the spec's restrictive default).
- ChatGPT requires `_meta.ui.domain` (a dedicated origin, unique per app) only for app submission; add it on the resource contents when submitting, with the value OpenAI assigns.
- Resource URIs are cache keys in ChatGPT: if the viewer ever changes incompatibly, publish it under a new URI.
- The tool also sets `openai/toolInvocation/invoking` and `invoked` status texts, and the resource sets `openai/widgetDescription`, which ChatGPT reads.

## Trying it in a real host

1. Wire `registerAppsTools` into `createServer` (item 44).
2. Claude Desktop or VS Code: add the stdio server (`npm run mcp`) and ask for `open_transcript_viewer` on a YouTube URL.
3. ChatGPT: run the Streamable HTTP server (item 45), expose it with a tunnel (for example `cloudflared tunnel --url http://127.0.0.1:<port>`), add it as a connector in developer mode and call the tool.
4. ext-apps `basic-host`: clone `modelcontextprotocol/ext-apps`, build `examples/basic-host`, and start `serve.ts` with `SERVERS='["http://localhost:<port>/mcp"]'`. Start the HTTP server with `VID2CONTEXT_MCP_TOKENS=<token>` and `VID2CONTEXT_CORS_ORIGINS=http://localhost:<host port>` (the host calls `/mcp` from the browser), and pass the token to the host's `StreamableHTTPClientTransport` through `requestInit.headers`, since `basic-host` sends no auth header of its own. Its sandbox proxy URL is fixed to port 8081 in `src/implementation.ts`; change it there if you use another `SANDBOX_PORT`.
