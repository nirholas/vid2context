# Evals test fixtures

Real caption tracks the metric tests score. Each file is a recorded reference (`RecordedRef`, see `src/refs.ts`): the segments exactly as YouTube served them, plus where they came from.

| File | Source | Recorded |
|---|---|---|
| `youtube-9Pd5fi1DCb8.auto-captions.en.json` | YouTube auto-captions of [Me At The Zoo (REUPLOAD)](https://www.youtube.com/watch?v=9Pd5fi1DCb8), 8 segments, no punctuation, includes `[Music]` and "um". Copied segment for segment from `packages/dedupe/test/fixtures/youtube-9Pd5fi1DCb8.json`. | 2026-11-14, vid2context CLI `--mode captions` |
| `youtube-g5RBHWskGtc.auto-captions.en.json` | YouTube auto-captions of [Me at the zoo (reupload)](https://www.youtube.com/watch?v=g5RBHWskGtc), 8 segments, punctuated and capitalized. Copied from `packages/dedupe/test/fixtures/youtube-g5RBHWskGtc.json`. | 2026-11-14, vid2context CLI `--mode captions` |

Both reuploads carry the same 19 seconds of audio as the original "Me at the zoo" (`jNQXAC9IVRw`), whose creator captions are in the shared fixture `tests/fixtures/contexts/youtube-jNQXAC9IVRw.json`. That makes them a real creator-captions versus auto-captions pair of the same speech, which is what the WER, timing and punctuation tests need. The reupload audio starts about one second earlier than the original, which shows up in the timing test as a real offset.

The tests also read the shared fixtures `tests/fixtures/contexts/youtube-jNQXAC9IVRw.json` and `youtube-cCPsdFdlshc.json` directly. Nothing personal is in these files: public video titles and caption text only.
