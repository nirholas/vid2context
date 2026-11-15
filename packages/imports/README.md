# @vid2context/imports

Turns a transcript from somewhere other than the platform into a normal `VideoContext`: text the user pasted, a subtitle file they uploaded, or segments the vid2context browser extension read from YouTube with the user's own IP address. It exists because YouTube blocks caption downloads from many cloud IPs; the metadata still comes from the server, the transcript comes from the user.

The contract is [docs/contracts/transcript-import.md](../../docs/contracts/transcript-import.md). The package is runtime-neutral (no `node:*`), so the web app runs the same code in the browser when there is no API.

## What it reads

The format is detected from the content; a filename only breaks ties and can carry the language (`talk.en.srt`).

| Format | Recognised by |
|---|---|
| `vtt` | `WEBVTT` header. Voice, class and timing tags are stripped; rolling auto-caption repeats are dropped; `Language:` gives the language |
| `srt` | cues timed `00:00:01,000 --> 00:00:04,000`; cue numbers and markup (`<i>`, `{\an8}`) are dropped |
| `youtube-transcript` | the text copied from the "Show transcript" panel on YouTube. The 2026 panel copies each row as timestamp, spoken label and text run together (`0:011 secondAll right...`), with chapter headings on their own lines; both are handled, as is a timestamp alone on a line with the text below it |
| `srv3`, `srv1`, `json3` | YouTube timedtext bodies, read with the timedtext parsers of `@vid2context/provider-youtube` |
| `plain` | anything else: one segment per paragraph, all at 0 s, ending at the video's duration when known |

CRLF and lone CR line ends, a byte order mark and HTML entities are handled everywhere. JSON or markup that is not YouTube timedtext is refused rather than imported as text.

## Use

```ts
import { importTranscript, parseTranscriptText } from '@vid2context/imports';

parseTranscriptText(text, { filename: 'talk.en.srt', durationSec: 1093 });
// { segments: [{ startSec, endSec, text }, ...], format: 'srt', language: 'en' }

const { context, format, saved } = await importTranscript(
  registry,
  { url: 'https://youtu.be/jNQXAC9IVRw', text, via: 'paste' },
  { storage, hosted: false },
  ctx,
);
```

`importTranscript` validates the request (exactly one of `text` and `segments`, every segment with a finite `startSec >= 0` and text, at most 50,000 segments), resolves the url to one video, fetches its metadata (falling back to minimal metadata with an `error` attempt), and returns a context with `transcript.origin: 'imported'` and `producer: 'import/<via>'`. It saves to `storage` unless `hosted` is set. In the browser without an API, pass `fetchMetadata: false` and the `metadata` the extension sent.

## HTTP

```ts
import { importRoutes } from '@vid2context/imports/http';
app.route('/api/v1', importRoutes({ registry, makeCtx, storage, hosted: (req) => isHosted }));
```

`POST /imports` takes the JSON body above (at most 5 MB, `too-large` otherwise) and answers `201 { context, format, saved }`. Without a `hosted` callback it reads `VID2CONTEXT_HOSTED` from the request's env. In hosted mode nothing is saved, because instance storage is shared and an imported transcript is not verified.

## Tests

`npx vitest run packages/imports`. Every input is real: recorded "Show transcript" copies in [test/fixtures/](test/fixtures/README.md), and SRT, WebVTT and YouTube recordings from other packages' fixtures.
