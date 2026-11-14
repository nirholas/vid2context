# Visual notes: on-screen text, slides and code

A transcript only has what was said. Talks, tutorials and buyer's guides also show things: the slide with the benchmark table, the code on screen, the price list. Visual notes capture that as timed text next to the transcript:

```json
{ "atSec": 80.4, "kind": "code", "text": "{{Infobox - panovník\n| jméno = Václav I.\n...", "producer": "visual/ovh/Qwen2.5-VL-72B-Instruct" }
```

`kind` is `slide`, `code`, `chart`, `ocr` (other readable text) or `description` (a one-line description of a frame with no text). Notes land in `VideoContext.visual`; the raw transcript is never changed.

This works on any video file, locally and for free. For a key-based alternative that sends a YouTube URL to Gemini, see [anthropic-and-gemini.md](anthropic-and-gemini.md).

## Try it

```sh
npx tsx providers/visual-frames/scripts/visual-notes.ts talk.mp4
npx tsx providers/visual-frames/scripts/visual-notes.ts https://vimeo.com/123456 --max-frames 20
npx tsx providers/visual-frames/scripts/visual-notes.ts talk.mp4 --policy local-only
```

It prints `{ notes, frames, attempts, durationSec }` as JSON. `VID2CONTEXT_LOG_LEVEL=info` shows progress on stderr.

From code (Node only):

```ts
import { extractVisualNotes } from '@vid2context/provider-visual-frames/node';
import { createNodeContext, createRegistry } from '@vid2context/registry/node';

const ctx = createNodeContext();
const { notes, frames, attempts } = await extractVisualNotes('talk.mp4', { rungs: createRegistry().visualRungs(ctx.env) }, ctx);
```

Without `rungs`, the package's own rungs are used.

## How it works

1. **Sample.** One ffmpeg pass picks frames where the picture changes (ffmpeg's scene score), plus one frame at least every `maxIntervalSec`, never two closer than `minIntervalSec`. A scene change is taken `settleSec` after the last frame over the threshold, so a slide that dissolves in is read once it is fully visible, not half blended. Each frame is written as a JPEG (`width` pixels wide) and as a 128x72 grayscale thumbnail for hashing.
2. **Dedupe.** Each thumbnail gets a 64-bit difference hash (dHash, pure TypeScript). Consecutive frames within `hashThreshold` bits of the run's first frame are the same picture: the run keeps its first time and its sharpest frame (highest Laplacian variance). For a slide that builds up bullet by bullet, the sharpest frame is usually the fullest one.
3. **Budget.** At most `maxFrames` frames go to rungs. When there are more, the duration is split into `maxFrames` windows, each window keeps its biggest visual change, and the remaining slots go to the biggest changes overall.
4. **Read.** Each frame goes through the visual rung chain (`runChain`), so cooldowns, `VID2CONTEXT_SKIP`, policies and fallbacks apply as everywhere else.
5. **Tidy.** Notes are sorted by time; a note whose text is at least 90% similar (character bigrams) to the note just before it is merged into that first occurrence.

URLs are downloaded first with yt-dlp at 480p or lower, video only, into `.vid2context/cache/` (`VID2CONTEXT_HOME`), and deleted afterwards along with the frames.

## Knobs

| Option | Default | Effect |
|---|---|---|
| `sceneThreshold` | 0.3 | scene score from 0 to 1 that counts as a new picture. Lower (0.1) catches soft cross-fades; higher ignores camera moves |
| `minIntervalSec` | 2 | never two frames closer than this |
| `maxIntervalSec` | 30 | at least one frame this often, even without a scene change |
| `settleSec` | 1 | wait this long after a scene change before taking the frame; 0 takes the change frame itself |
| `width` | 1024 | JPEG width sent to rungs (never upscaled) |
| `hashThreshold` | 12 | dHash bits (of 64) under which consecutive frames are the same picture |
| `maxFrames` | 40 | most frames sent to rungs per video |
| `maxWaitSec` | 120 | when every rung is rate-limited, wait up to this long for the next slot; 0 skips the frame instead |
| `chain` | `{}` | chain options: `policy`, `only`, `skip`, `needs` |
| `rungs` | this package's | the visual rungs to use |

The hash threshold comes from measurements on the fixture talk: the same slide with a different burned-in subtitle differs by 5 to 6 bits, an animated code screen drifts by up to 11, and different slides differ by 23 or more.

## Rung order

Free first, like every chain:

1. `visual/ollama/<model>`: a local vision model, when `OLLAMA_VISION_MODEL` is set (`qwen2.5vl` or `llava`). It runs before tesseract because setting it says you want a model to read your frames.
2. `visual/tesseract/<langs>`: local OCR with tesseract.js, on by default. Returns plain `ocr` notes. Set `TESSERACT_LANGS` to the language on screen (`ces+eng`, `deu`, `chi_sim`); English ships with the package, other languages download once (about 2 to 3 MB each) to `.vid2context/models/tesseract`.
3. `visual/gemini/<model>`: your free Gemini key (`GEMINI_API_KEY`).
4. `visual/ovh/Qwen2.5-VL-72B-Instruct`: keyless OVH, no account.

`local-only` keeps only Ollama and tesseract. Each vision rung asks for one JSON object: the kind, the on-screen text copied exactly (code verbatim, tables as Markdown), or a one-line description when there is no text. Variables: [providers.md](../providers.md#on-screen-text-and-slides-visual-frames).

With the default rungs, tesseract reads every frame, so nothing leaves the machine. To use a vision model for richer notes (kinds, verbatim code, tables), set `OLLAMA_VISION_MODEL`, or turn tesseract off (`TESSERACT_ENABLED=0`) to use Gemini or keyless OVH.

## Privacy

- tesseract and Ollama read frames on your machine. Frames never leave it.
- Gemini and OVH receive the frames they read (JPEG, `width` pixels wide). The frame budget caps how many: 40 per video by default.
- `VID2CONTEXT_KEYLESS=0` turns off keyless OVH; `VID2CONTEXT_POLICY=local-only` turns off every hosted rung.

## Costs and limits

- Everything here is free. Tesseract costs CPU: about 0.4 to 2 s per frame on a CPU VM (measured 2026-11-14), so 40 frames take about a minute.
- Keyless OVH allows about 2 requests per minute per model per IP. The rung spaces requests 30 s apart (`OVH_VISION_INTERVAL_SEC`); while it rests, the chain uses other rungs, and if none is left the pipeline waits for the next slot. 40 frames through OVH alone take about 20 minutes.
- Gemini's free tier has per-minute and per-day caps that change; requests are spaced 4 s apart (`GEMINI_VISION_INTERVAL_SEC`).
- Burned-in subtitles are on-screen text too. Tesseract reads them; vision models are told to ignore them but sometimes copy a line anyway. They repeat the transcript, so they are harmless but take space.
- English tesseract data on non-English slides drops accents (`výzkum` becomes `vyzkum`) and misreads small text. Set `TESSERACT_LANGS` to the slide language.
- Frame sampling needs Node and ffmpeg (`FFMPEG_PATH`). In the browser and on Workers, the rungs can read frames you pass yourself (`rung.read({ data, mimeType, atSec }, ctx)`); tesseract is not available on Workers.
