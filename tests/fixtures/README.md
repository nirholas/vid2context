# Shared fixtures

Real data any package's tests may read. Never edit these by hand; re-record them instead.

## media/

| File                      | Source                                                                                                                                                                                     | License              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `apollo11-small-step.mp3` | [Armstrong Small Step.ogg](https://commons.wikimedia.org/wiki/File:Armstrong_Small_Step.ogg) (Neil Armstrong/NASA) converted with `ffmpeg -ac 1 -ar 16000 -b:a 48k`. 24.2 s, 145,412 bytes | Public domain (NASA) |

## contexts/

Real `VideoContext` JSON produced by the vid2context pipeline (`npm run cli -- <url> --format json`) on 2026-11-14.

| File                       | Video                                                                     | Transcript                                               |
| -------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| `youtube-jNQXAC9IVRw.json` | "Me at the zoo" (19 s)                                                    | creator captions, en, 6 segments, 3 description chapters |
| `youtube-cCPsdFdlshc.json` | "Best & Worst G-Wagon Years" (18 min, part 1 of a G-Wagon buyer's series) | auto-captions, en, 521 segments, no chapters             |

`youtube-cCPsdFdlshc.json` has a person's email and phone number in the description replaced with `[email redacted]` and `[phone redacted]`.

Use them to test formatters, cleanup, chunking and search against real transcripts instead of invented ones.
