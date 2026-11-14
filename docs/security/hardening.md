# Hardening

How to run vid2context safely in public, and how every package must use the shared defenses in [packages/core/src/security/](../../packages/core/src/security/). The threats behind these rules: [threat-model.md](threat-model.md).

## Public deployments

Set these on any server, container or Worker that strangers can reach (the HTTP API, the remote MCP endpoint, a hosted web app):

| Setting | Why |
|---|---|
| `VID2CONTEXT_PUBLIC=1` | Refuses local file paths, `file://` and other non-web schemes, and URLs that point at private, loopback, link-local or metadata addresses. Also enforces the input length limit. |
| `VID2CONTEXT_API_KEYS=key1,key2` | Requires `Authorization: Bearer <key>` on every route except health (owner: item 46). |
| `VID2CONTEXT_CORS_ORIGINS` | Leave unset unless the web app or extension runs on another origin; then list exactly those origins. |
| `VID2CONTEXT_KEYLESS=0` | When the content is sensitive. Keyless lanes send audio and text to third parties without an account. |
| `VID2CONTEXT_POLICY=local-only` | When nothing may leave the machine at all. |
| `VID2CONTEXT_MAX_*`, `VID2CONTEXT_FETCH_TIMEOUT_MS` | Tighten the limits below to what your hardware and quotas allow. |

Also:

- Bind to `127.0.0.1` and put a reverse proxy or tunnel in front, unless the platform does this for you.
- Run in a container or network namespace without a route to cloud metadata or your LAN. On AWS, require IMDSv2 with a hop limit of 1; on GCP, use a service account with no scopes the server does not need.
- Do not expose a server behind your home connection to everyone: YouTube blocks by IP, and you would share the block.
- Keep keys in the platform's secret store, not in the image.

## Limits

One function, `limits(env)`, returns every cap. Import it instead of inventing your own numbers.

| Env var | Default | Used for |
|---|---|---|
| `VID2CONTEXT_MAX_INPUT_CHARS` | 2048 | longest input string accepted in public mode |
| `VID2CONTEXT_MAX_PLAYLIST_ITEMS` | 500 | most videos expanded from one playlist, channel or feed |
| `VID2CONTEXT_MAX_UPLOAD_MB` | 200 | largest upload to the HTTP API or web app |
| `VID2CONTEXT_MAX_AUDIO_MB` | 1024 | largest audio download or file read for speech-to-text |
| `VID2CONTEXT_MAX_SEGMENTS` | 200000 | most transcript segments kept from one source |
| `VID2CONTEXT_FETCH_TIMEOUT_MS` | 30000 | default timeout for one outbound request (`safeFetch`) |

```ts
import { limits } from '@vid2context/core';
const { maxUploadBytes, maxPlaylistItems } = limits(ctx.env);
```

## Rules for packages

### Fetching a URL a user gave you: `safeFetch`

Any provider that fetches a user-supplied URL (podcast feeds, web pages, direct media links, transcripts linked from feeds) must use `safeFetch` instead of `ctx.fetch`. It re-checks every redirect hop, caps the body and applies a timeout.

```ts
import { limits, safeFetch } from '@vid2context/core';

const res = await safeFetch(ctx, feedUrl, {
  maxBytes: 10 * 1024 * 1024,
  accept: ['application/rss+xml', 'application/xml', 'text/xml'],
});
if (res.status !== 200) throw new Vid2ContextError('upstream', `feed: HTTP ${res.status}`);
const xml = new TextDecoder().decode(res.bytes);
```

For audio, pass `maxBytes: limits(ctx.env).maxAudioBytes`. Fixed, trusted API endpoints (Groq, Gemini, the YouTube innertube API) do not need `safeFetch`; keep using `ctx.fetch` with `fetchWithTimeout`.

Local services such as Ollama are private by design. Never pass them through the public policy; if you must use `safeFetch` for them, allow exactly that host: `policy: { allowHosts: ['127.0.0.1:11434'] }`.

### DNS checks on Node: `setHostResolver`

Core cannot import `node:dns`, so Node entry points (the CLI, the stdio MCP server, the Node HTTP server) register a resolver once at startup. Every `checkUrl`, `safeFetch` and public-mode input check then also validates DNS answers, which refuses names like `127.0.0.1.nip.io`:

```ts
import { lookup } from 'node:dns/promises';
import { setHostResolver } from '@vid2context/core';

setHostResolver(async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address));
```

`lookup` uses the system resolver and `/etc/hosts`, the same path `fetch` uses, so it sees what the request would see. Workers have no local network to protect and need no resolver.

### Checking inputs: `checkInput` and `enforceInputPolicy`

`getVideoContext` and `expandInput` already call `enforceInputPolicy` first. Surfaces that act on an input without the pipeline (for example a route that lists a feed or downloads a file directly) must call it themselves:

```ts
import { enforceInputPolicy } from '@vid2context/core';
await enforceInputPolicy(input, ctx); // throws Vid2ContextError('unsupported-input') with a hint
```

`checkInput(input, env)` is the synchronous form: it returns the error to throw, or `undefined`.

### Logging and showing errors: `redact`

The default stderr logger and rung attempt details are redacted automatically. Anything else that prints or returns error text must pass it through `redact` with the context env:

```ts
import { redact } from '@vid2context/core';
console.error(redact(err.message, ctx.env));
res.json(redact({ error: err.message, attempts }, ctx.env));
```

This applies to CLI error output, HTTP error bodies, MCP tool errors, stored job errors and anything sent to telemetry. A custom `Logger` passed to `createContext` is not wrapped; redact inside it.

### Sending untrusted text to an LLM: `fenceUntrusted`

Transcripts, comments, descriptions, chapter titles and web pages are written by strangers. Before any of it goes into a prompt, wrap it:

```ts
import { fenceUntrusted, UNTRUSTED_SYSTEM_PROMPT } from '@vid2context/core';

const t = fenceUntrusted(transcriptText, 'transcript', ref.url);
const messages = [
  { role: 'system', content: `${taskInstructions}\n\n${UNTRUSTED_SYSTEM_PROMPT}` },
  { role: 'user', content: `Summarize this video.\n\n${t.block}` },
];
```

- Briefs (item 32): fence each video's transcript separately, with the video URL as `source`, so citations stay attributable and one video cannot instruct the model about another.
- Ask and chat (item 34): fence retrieved passages; the user's own question stays outside the fence, since it is the instruction.
- Translation (item 35): fence the source text and tell the model to translate the fenced content only. Never let fenced text pick the target language or the output format.
- Never put keys, other users' data or tool permissions in a prompt that also carries fenced content.

### Running binaries: `assertSafeArg`

Every value built from user input and passed as a positional argument to yt-dlp, ffmpeg, deno or whisper.cpp goes through `assertSafeArg(value, 'URL')`, which refuses values starting with `-` and those with NUL or line breaks. Also put `--` before positionals where the binary supports it, and never use a shell (`spawn` with an argument array, not `exec`).

### Writing files: `safeFilename` and `safeJoin`

- Names built from titles or uploads: `safeFilename(title)` (strips separators, control and bidi characters, reserved Windows names, trailing dots).
- Any untrusted relative path under a base directory: `safeJoin(base, name)` (refuses `..`, absolute paths, drive letters and NUL).

## Reporting

See [SECURITY.md](../../SECURITY.md) for how to report a vulnerability privately.
