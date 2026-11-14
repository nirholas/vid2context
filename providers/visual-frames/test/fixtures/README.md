# visual-frames fixtures

All real data, recorded 2026-11-14 on a GCP VM. Nothing here is invented or edited, except where noted.

## Media

The source is "New Editor Experiences presentation for Czech Wikiconference 2017" by Neil P. Quinn and Abbey Ripstra (Wikimedia Foundation), [File:New_Editor_Experiences_presentation_for_Czech_Wikiconference_2017.webm](https://commons.wikimedia.org/wiki/File:New_Editor_Experiences_presentation_for_Czech_Wikiconference_2017.webm) on Wikimedia Commons, licensed **CC BY-SA 3.0**. The talk is in Czech with burned-in subtitles. Its first two minutes have speakers, a title slide, a line chart, a split screen, a wikitext (code) screen and a rendered Wikipedia article. These fixtures are adaptations under the same license.

| File | How it was made |
|---|---|
| `new-editor-experiences-0-120.mp4` | The first 30 MB of the original WebM (1280x720 VP9) fetched with `curl -r 0-30000000`, then `ffmpeg -ss 0 -t 120 -i part.webm -an -vf scale=960:-2 -c:v libx264 -preset slow -crf 30 -tune stillimage -movflags +faststart`. 120 s, 960x540, no audio, 1,939,408 bytes. ffmpeg 7.0.2 static build. Scene cuts (score over 0.1): 26.9 s title slide, 36.3 s chart, 71.1 s split screen, 79.2 to 79.4 s code screen, 107.4 s article |
| `frame-005s.jpg`, `frame-030s.jpg`, `frame-050s.jpg`, `frame-062s.jpg`, `frame-085s.jpg`, `frame-100s.jpg`, `frame-112s.jpg` | single frames from the clip at 5, 30, 50, 62, 85, 100 and 112 s: `ffmpeg -ss <t> -i new-editor-experiences-0-120.mp4 -frames:v 1 -vf "scale='min(1024,iw)':-2" -q:v 3`, the same scale and quality the pipeline uses. Speakers (5), title slide (30), chart (50 and 62, with different subtitles), code screen (85 and 100), article (112) |

## ffmpeg sampling run

| File | How it was made |
|---|---|
| `sampled-max5.thumbs.gray` | stdout of ffmpeg run with exactly the arguments `samplingArgs('new-editor-experiences-0-120.mp4', 'frames', resolveSampleOptions({ maxIntervalSec: 5 }), 7)` produce (scene threshold 0.3, settle 1 s, min interval 2 s, max interval 5 s): 25 grayscale 128x72 thumbnails, 9,216 bytes each |
| `sampled-max5.stderr.txt` | stderr of the same run (showinfo lines and the input banner). Edited: the absolute path of the temporary JPEG output directory was replaced with `frames/` |

## OVH AI Endpoints (keyless)

Responses from `POST https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions`, model `Qwen2.5-VL-72B-Instruct`, no key sent. Each request body was `buildVisionBody({ model: 'Qwen2.5-VL-72B-Instruct', jsonMode: true }, frame)` from `src/vision.ts`: the system prompt `VISION_PROMPT`, the frame as an image data URL and `response_format: json_object`. The response bodies are stored re-indented as JSON. En and em dashes inside strings are written as `\u2013` and `\u2014` escapes (the same JSON value; the repo bans those characters in files).

| File | Frame | Reply |
|---|---|---|
| `ovh-qwen2.5-vl-72b.frame-030s.json` | title slide | `slide`, the two-line question |
| `ovh-qwen2.5-vl-72b.frame-050s.json` | chart | `chart`, axis labels and title plus the burned-in subtitle line |
| `ovh-qwen2.5-vl-72b.frame-062s.json` | same chart | `chart`, without the subtitle line |
| `ovh-qwen2.5-vl-72b.frame-085s.json` | code screen | `code`, the wikitext verbatim |
| `ovh-qwen2.5-vl-72b.frame-100s.json` | same code screen | `code` |
| `ovh-qwen2.5-vl-72b.frame-005s.json` | speakers | `description`, no text |
| `ovh-qwen2.5-vl-72b.frame-112s.json` | article | `ocr`, the article text |
| `ovh-qwen2.5-vl-72b.429.json` | frame 62, third request within a minute | `{ status, headers, body }`: HTTP 429, `retry-after: 26`, `x-ratelimit-limit-minute: 2`, body `API rate limit exceeded` (only the rate-limit and content-type headers were kept) |

## tesseract.js

| File | How it was made |
|---|---|
| `tesseract-eng.frame-005s.blocks.json` | `worker.recognize(frame-005s.jpg, {}, { blocks: true })` with tesseract.js 7.0.0, `eng` 4.0.0_best_int traineddata from `@tesseract.js-data/eng`, OEM 1, reduced to each line's `text` and `confidence`. The speakers' photo: low-confidence noise plus the misread subtitle line |
