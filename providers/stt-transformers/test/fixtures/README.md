# stt-transformers fixtures

Real output of the Transformers.js automatic-speech-recognition pipeline, recorded with `npx tsx providers/stt-transformers/test/record.ts` on 2026-11-14 (Node 24, `@huggingface/transformers` 4.3.2, onnxruntime-node CPU, `onnx-community/whisper-base`, encoder and decoder fp32). Each file holds the model, device, dtype, audio duration, the language our detection step chose, and the raw pipeline output (`text` and `chunks` with `timestamp` pairs) exactly as returned. Nothing personal is in them.

| File | Input | Notes |
|---|---|---|
| `whisper-base.apollo.json` | `tests/fixtures/media/apollo11-small-step.mp3` (public domain, NASA), 24.1 s | 3 chunks; language detected as `en` |
| `whisper-base.apollo-x3.json` | the same clip played three times in a row (`ffmpeg -stream_loop 2`), 72.4 s | 9 chunks spanning three 30 s windows with 5 s strides, so absolute offsets after the first window are exercised |
