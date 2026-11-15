# Reference transcripts

Human reference transcripts the eval suites score against, recorded once so scoring does not depend on any host staying reachable. Each file is a `RecordedRef` (`src/refs.ts`): the segments exactly as published, plus the language, origin, producer, the date it was downloaded and, for files that are not a video's own caption track, the `source` URL.

File names: `<platform>-<id>.<origin>.<language>.json`, where the id is the one vid2context resolves for the dataset URL (`media-<sha256 of the URL>` for direct media URLs, `youtube-<video id>` for YouTube). A dataset entry can also name its file with `referenceFile` (used for the local Apollo clip, whose resolved id depends on file timestamps).

Only public-domain and Creative Commons references are committed (dataset entries with `storeReference: true`). References for videos under the standard YouTube license are cached locally under `.vid2context/cache/evals/refs/` when a run fetches them, never committed.

Record or refresh: `LIVE=1 npm run eval -- --suite stt --record` (downloads only what is missing; delete a file to re-record it).

## NASA Image and Video Library (public domain)

Video and captions both come from NASA's own library at images-assets.nasa.gov, not YouTube. The reference is the SRT file NASA publishes next to each video (asset list: `https://images-api.nasa.gov/asset/<NASA id>`), parsed with the media-file provider's `parseSubtitles`. NASA media is generally not subject to US copyright (NASA media usage guidelines). Downloaded 2026-11-15.

| Dataset id | Language | NASA id | Title |
|---|---|---|---|
| `nasa-lib-black-hole` | en | What is a Black Hole | What is a Black Hole / We Asked a NASA Expert |
| `nasa-lib-recientemente` | es | 20230317_recientemente | Recientemente: El presidente solicita presupuesto para la NASA - 17/03/23 |
| `nasa-lib-uranus` | en | Have We Been to Uranus | Have We Been to Uranus? / We Asked a NASA Expert |
| `nasa-lib-space-dangers` | en | What Are the Dangers of Going to Space | What Are the Dangers of Going to Space / We Asked a NASA Expert |
| `nasa-lib-moon-horizon` | en | Why Does the Moon Look Larger at the Horizo | Why Does the Moon Look Larger at the Horizon? We Asked a NASA Expert |
| `nasa-lib-zero-gravity` | en | How Do We Do Research in Zero Gravity | How Do We Do Research in Zero Gravity / We Asked a NASA Expert |
| `nasa-lib-planet-names` | en | How Do Planets Get Their Names_ - Horizontal Video | How Do Planets Get Their Names? We Asked A NASA Expert |
| `nasa-lib-found-life` | en | What Would It Take To Say We Found Life? - Tori Hoehler | What Would It Take To Say We Found Life? We Asked a NASA Expert |
| `nasa-lib-spinoff` | en | What is a NASA Spinoff | What is a NASA Spinoff |
| `nasa-lib-northern-lights` | en | How Can I See the Northern Lights | How Can I See the Northern Lights? We Asked a NASA Expert |
| `nasa-lib-polar-ice` | en | Is Polar Ice Melting | Is Polar Ice Melting? We Asked a NASA Expert |
| `nasa-lib-earthquakes` | en | Are There Earthquakes On Other Planets_ - Horizontal Video | Are There Earthquakes On Other Planets? We Asked A NASA Expert |
| `nasa-lib-moon-rocks` | en | Where Are the Moon Rocks_ - Horizontal Video | Where Are the Moon Rocks? We Asked A NASA Expert |
| `nasa-lib-rubio-treadmill` | es | jsc2023m000211_Frank Rubio_Treadmill_Exercise_in_Space_Spanish_HighQuality_1080p_MP4 | Cómo correr en microgravedad (How to Run in Microgravity-Spanish) |

Each file's `source` field holds the exact SRT URL; the `url` field holds the `~mobile.mp4` rendition the stt suite transcribes.

## Apollo 11 (public domain)

`apollo11-small-step.human-transcript.en.json`: the 24-second clip in `tests/fixtures/media/apollo11-small-step.mp3` (from Wikimedia Commons [File:Armstrong_Small_Step.ogg](https://commons.wikimedia.org/wiki/File:Armstrong_Small_Step.ogg), Neil Armstrong/NASA, PD-USGov-NASA). The text is the transcription in that file's description, "And, uh, step off the LM now. That's one small step for man, one giant leap for mankind.", without the editorial "[a]", which is not audible. It is one segment spanning the whole clip, so word timing for this item is not meaningful; WER and CER are. Written 2026-11-15.

## YouTube creator captions (public domain or CC)

Creator-uploaded caption tracks of NASA (public domain) and TED, TED-Ed and TEDx (CC BY-NC-ND 4.0, attribution: TED) videos, downloaded through the pipeline with auto-captions disallowed (`getVideoContext`, `mode: 'captions'`, `allowAuto: false`), so a translated or auto track can never become a reference. YouTube rate-limits caption downloads from some IPs (HTTP 429); entries that could not be fetched yet are fetched on a later `--record` run.

| File | Video | Downloaded |
|---|---|---|
| `youtube-GB06dUoGGRI.creator-captions.en.json` | NASA, "How Do We Know the Earth Isn't Flat? We Asked a NASA Expert" | 2026-11-15 |
