# Transformers.js fixtures

| File | How it was recorded |
|---|---|
| `multilingual-e5-small-q8.passages.json` | 2026-11-14, Node 24 on a GCP VM, `@huggingface/transformers` 4.3.2. `pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { device: 'cpu', dtype: 'q8' })`, then the eight sentences from `providers/embed/test/fixtures/sentences.json` (real auto-captions from `tests/fixtures/contexts/youtube-cCPsdFdlshc.json`) with the `passage: ` prefix, `{ pooling: 'mean', normalize: true }`. The file stores the output tensor's `dims` ([8, 384]) and flat `data`. Model download took about 2 s and the embedding about 120 ms. |

The model is MIT licensed (intfloat/multilingual-e5-small, ONNX export by Xenova). No model weights are stored here.
