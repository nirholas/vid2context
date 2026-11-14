# @vid2context/provider-embed-transformers

Local embeddings with Transformers.js, for Node (onnxruntime-node) and the browser (WebGPU, falling back to WASM). Not for Workers.

Set `TRANSFORMERS_EMBED_MODEL=Xenova/multilingual-e5-small` to enable it. The model downloads once (118 MB, quantized) into `.vid2context/models` or `$VID2CONTEXT_HOME/models`, loads on first use and is reused. It produces 384-dimension unit vectors and adds the e5 `query: ` and `passage: ` prefixes itself.

The rung id is `embed/transformers/<model>`. Like every embedding model, it needs its own index: see the pinning rule in [docs/guides/embeddings.md](../../docs/guides/embeddings.md).
