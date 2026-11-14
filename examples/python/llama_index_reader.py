"""Read videos into LlamaIndex Documents in windows of about 90 seconds,
ready for a VectorStoreIndex. The citation fields (url, video_id) stay on
each node but out of the embedded text.

    npm run start:server                          # in another terminal
    pip install "./clients/python[llama-index]"   # from the repo root
    python examples/python/llama_index_reader.py [base-url]

Live, no keys needed.
"""

from __future__ import annotations

import sys

from vid2context.llama_index import VideoContextReader

reader = VideoContextReader(
    chunking="window",
    window_sec=90,
    base_url=sys.argv[1] if len(sys.argv) > 1 else None,
)
docs = reader.load_data(["https://www.youtube.com/watch?v=cCPsdFdlshc"])

print(f"{len(docs)} documents")
for doc in docs[:3]:
    m = doc.metadata
    print(f"  window {m['window_index']}: {m['start_sec']}s to {m['end_sec']}s  {m['url']}")
print(f"kept out of embeddings: {', '.join(docs[0].excluded_embed_metadata_keys)}")
