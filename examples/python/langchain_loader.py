"""Load videos as LangChain Documents, one per chapter, with the video id,
title, start and end seconds and a timestamp link in metadata. Documents
have stable ids, so loading the same video again upserts in a vector store.

    npm run start:server                          # in another terminal
    pip install "./clients/python[langchain]"     # from the repo root
    python examples/python/langchain_loader.py [base-url]

Live, no keys needed.
"""

from __future__ import annotations

import sys

from vid2context.langchain import VideoContextLoader

loader = VideoContextLoader(
    ["https://www.youtube.com/watch?v=jNQXAC9IVRw", "https://www.youtube.com/watch?v=cCPsdFdlshc"],
    chunking="chapters",  # or "segments", or "window" with window_sec=90
    base_url=sys.argv[1] if len(sys.argv) > 1 else None,
    continue_on_failure=True,
)

docs = loader.load()
print(f"{len(docs)} documents")
for doc in docs[:3]:
    m = doc.metadata
    print(f"\n{doc.id}")
    print(f"  {m['title'][:40]} [{m['start_sec']}s to {m['end_sec']}s] {m.get('chapter', '')}")
    print(f"  {m['url']}")
    print(f"  {doc.page_content[:90]}...")
