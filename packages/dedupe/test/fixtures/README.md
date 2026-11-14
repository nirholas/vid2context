# Dedupe fixtures

Real `VideoContext` JSON recorded with the vid2context CLI on 2026-11-14:

```sh
npm run cli -- "https://www.youtube.com/watch?v=<id>" --format json --mode captions > youtube-<id>.json
```

Nothing was edited. The files hold public video metadata (title, channel, description, view count) and the captions YouTube served; none contains a stream URL, email address or phone number.

The shared fixtures in `tests/fixtures/contexts/` are used too: `youtube-jNQXAC9IVRw.json` ("Me at the zoo", the original) and `youtube-cCPsdFdlshc.json` (an 18-minute G-Wagon buyer's guide, a distinct-video negative).

## Reuploads of "Me at the zoo"

| File | Video | Transcript |
| --- | --- | --- |
| `youtube-g5RBHWskGtc.json` | [Me at the zoo (reupload)](https://www.youtube.com/watch?v=g5RBHWskGtc), RetroYTVideos, 19 s | auto-captions, 8 segments; close to the original's creator captions |
| `youtube-9Pd5fi1DCb8.json` | [Me At The Zoo (REUPLOAD)](https://www.youtube.com/watch?v=9Pd5fi1DCb8), 20 s | auto-captions, 8 segments; the recognizer heard "one of the elephants" for "in front of the elephants" and "fronts" for "trunks", and added `[Music]` and "um" |

The original (`jNQXAC9IVRw`) has creator captions. The three transcripts of the same 19 seconds of audio differ word by word, which is what the gap tolerance in `src/align.ts` is measured against.
