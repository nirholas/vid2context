# Transcript import and the extension bridge

When the server cannot read a video's captions (YouTube blocks many cloud IPs), the transcript can still come from somewhere else: the user's own browser through the vid2context extension, text the user pastes, a subtitle file the user uploads, or speech-to-text run on the video's own audio (a media file from the user's device, or audio the server downloaded with yt-dlp, transcribed in the browser or through `POST /uploads`). All of them end in one HTTP route, `POST /api/v1/imports`, which turns the transcript into a normal `VideoContext` for the video's link, with the video's real metadata.

Owners: `@vid2context/imports` (parser, `importTranscript`, the route factory), `packages/web` (the UI), `packages/extension` (the bridge). The server only mounts `importRoutes`.

## `POST /api/v1/imports`

JSON body, at most 5 MB (`too-large`, 413).

```ts
interface ImportRequest {
  /** The video the transcript belongs to: any input the registry resolves to a single video. */
  url: string;
  /** Exactly one of text or segments. */
  text?: string;
  segments?: { startSec: number; endSec?: number; text: string }[];
  /** BCP 47 code. Falls back to a language found in the text (WebVTT `Language:` header), then a language tag in `filename` (`talk.en.srt`), then the video's spoken language, then `und`. */
  language?: string;
  /** Helps format detection (`talk.en.srt`); never stored as a path. */
  filename?: string;
  /** Where the transcript came from. Default `paste` for text, `browser` for segments. */
  via?: 'paste' | 'file' | 'browser' | 'media';
  /** For via=browser: the kind of YouTube track the extension read. Recorded, not trusted. */
  captionKind?: 'creator-captions' | 'auto-captions';
  /** For via=media: the speech-to-text rung that made the segments (`stt/transformers/onnx-community/whisper-base`). Whitespace collapsed, at most 200 characters. Recorded, not trusted. */
  transcriber?: string;
  /** For via=browser: the metadata the extension sent. Only fills gaps when the source gives no metadata (title, channel, duration); never overrides it. */
  metadata?: { title?: string; channel?: string; durationSec?: number };
}
```

`text` formats, detected from the content (never only from `filename`):

| Format | Recognised by |
|---|---|
| WebVTT | `WEBVTT` header |
| SRT | numbered cues with `00:00:01,000 --> 00:00:04,000` |
| YouTube "Show transcript" copy | timestamp lines (`0:00`, `1:02:03`) alone or at the start of a line, text after or on the next lines; also the variant with spoken-length labels such as `2 seconds` and `1 minute, 5 seconds`. The 2026 panel copies timestamp, label and text run together on one line (`0:011 secondAll right`) with chapter headings on their own lines; the headings are dropped |
| YouTube timedtext | srv1, srv3 or json3 bodies (parsed with `parseTimedText` from `@vid2context/provider-youtube`) |
| plain text | anything else: one segment per paragraph, all at `startSec` 0, `endSec` the video duration when known. JSON or markup that is not YouTube timedtext is not plain text: nothing is parsed |

Validation: every segment needs a finite `startSec >= 0` and non-empty text after trimming. Segments are sorted by `startSec`; a missing `endSec` becomes the next segment's start (the last one gets the duration, or `startSec + 5`). At most 50,000 segments (`too-large` beyond). Nothing parsed is a `bad-request` with a hint that lists the accepted formats, answered before any network call.

Response `201`:

```ts
interface ImportResponse {
  context: VideoContext;
  /** The detected text format, or 'segments'. */
  format: 'vtt' | 'srt' | 'youtube-transcript' | 'srv1' | 'srv3' | 'json3' | 'plain' | 'segments';
  /** True when the context was written to storage, so later context, transcript, chat and MCP calls for this url use it. */
  saved: boolean;
}
```

The context:

- `metadata` from `source.getMetadata(ref, ctx)`. If that fails, minimal metadata (`title` is the url) and an `error` attempt; the import still succeeds.
- `transcript.origin` is `'imported'`, `transcript.producer` is `import/<via>`. Raw text is kept as given (trimmed, entities decoded); no LLM pass.
- `attempts` has the metadata attempt and `{ id: 'import', stage: 'captions', outcome: 'ok', detail: '<via>, <format>[, <captionKind>][, <transcriber>]' }`.

Saving: written with `storage.putContext` when the server has storage, except in hosted mode (`VID2CONTEXT_HOSTED=1`). There, instance storage is shared by users, and an imported transcript is not verified, so it is returned and never saved; the web app keeps it in the browser. Imported contexts are never written to the shared cache.

Errors: `bad-request` (no `url`, both or neither of `text` and `segments`, nothing parsed, invalid segments), `unsupported-input` (the url is a playlist, channel or page), `too-large`.

## Media in the web app (via=media)

The web app's "Get the transcript another way" panel offers two ways that work from the video itself:

- **Video or audio file**: the user picks a file on their device. The browser decodes it to 16 kHz mono (`packages/web/src/audio/prepare.ts`), then either transcribes it in the browser with the Whisper rung from `@vid2context/provider-stt-transformers` (plus any hosted rung whose key is saved in Settings), or uploads it (`POST /uploads`) and reads the transcript with `GET /context?url=upload:<sha256>`.
- **Server download**: `POST /downloads` with `{ kind: 'audio', format: 'm4a' }`. yt-dlp often still gets the audio when YouTube refuses the caption requests. When the job is done the user can save the file (`GET /downloads/:id/file`) or have the browser fetch it and transcribe it as above.

Either way the segments go to `POST /imports` with `via: 'media'`, the language the model detected and `transcriber`, the rung id from the speech-to-text attempt. In client-only mode only the in-browser transcription is offered.

## Extension bridge

The web app and the extension talk with `window.postMessage` on the web app's page. A content script, `bridge.js`, runs on the web app's origins and relays to the extension's background, which can reach YouTube from the user's own IP address.

Origins with the bridge: `https://vid2context.com/*`, `https://*.vid2context.com/*`, `http://localhost/*`, `http://127.0.0.1/*` (match patterns ignore ports), plus any origin the user adds in the extension options (registered with `chrome.scripting.registerContentScripts` once the optional host permission for it is granted).

Every message is a plain object with `source` and `type`. The content script accepts only messages whose `event.source === window` and `event.origin === location.origin`, with `source: 'vid2context-web'` and a known `type`. The web app accepts only messages with `source: 'vid2context-extension'` from its own window.

Detection:

```ts
// web -> extension
{ source: 'vid2context-web', type: 'ping', id: string }
// extension -> web, in answer to ping, and once unprompted when the content script loads
{ source: 'vid2context-extension', type: 'pong', id?: string, version: string, capabilities: ['youtube-transcript'] }
```

The web app treats the extension as absent when no `pong` arrives within 800 ms of a ping.

Fetching a transcript:

```ts
// web -> extension (sent from a click handler)
{ source: 'vid2context-web', type: 'youtube-transcript', id: string, videoId: string, language?: string }

// extension -> web, zero or more
{ source: 'vid2context-extension', type: 'progress', id: string, stage: 'player' | 'captions' | 'tab', message: string }

// extension -> web, exactly one
{
  source: 'vid2context-extension', type: 'youtube-transcript:result', id: string,
  ok: true,
  transcript: {
    language: string;
    kind: 'creator-captions' | 'auto-captions';
    name?: string;
    translated?: boolean;
    segments: { startSec: number; endSec: number; text: string }[];
  };
  metadata?: { title?: string; channel?: string; durationSec?: number };
}
| {
  source: 'vid2context-extension', type: 'youtube-transcript:result', id: string,
  ok: false,
  error: { code: 'bad-request' | 'not-found' | 'unavailable' | 'no-captions' | 'blocked' | 'timeout'; message: string; hint?: string };
}
```

`videoId` must match `^[A-Za-z0-9_-]{11}$` (`bad-request` otherwise). `language` follows the same track rules as `youtube-captions` (`chooseTrack`). The web app gives up after 90 seconds (`timeout`).

How the extension gets the captions, in order:

1. From the background: the innertube player and timedtext requests of `@vid2context/provider-youtube`, sent from the extension with the user's IP address and cookies.
2. If that is refused or comes back empty (YouTube wants a proof-of-origin token): a YouTube watch tab opened in the background, not focused. The existing main-world script captures the player's own caption request, and the tab is closed as soon as the captions arrive or after 45 seconds.

The web app then sends the result to `POST /api/v1/imports` with `segments`, `language`, `via: 'browser'`, `captionKind` and the result's `metadata`. Without an API (client-only mode) it builds the context in the browser with `importTranscript` from `@vid2context/imports` (option `fetchMetadata: false`, since the browser cannot reach YouTube's metadata; the metadata attempt is `skipped`) and keeps it locally.
