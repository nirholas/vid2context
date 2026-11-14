"""The vid2context Python client: outline first, then one section, then a
cited answer, and what an error looks like.

    npm run start:server                          # in another terminal
    pip install ./clients/python                  # from the repo root
    python examples/python/client_basics.py [base-url]

Live, no keys needed. Default base URL: VID2CONTEXT_API_URL, else
http://127.0.0.1:8787. POST /ask is not wrapped by the client yet, so it is
called with httpx (the client's only dependency) against the same server.
"""

from __future__ import annotations

import sys

import httpx

from vid2context import Client, Vid2ContextError

base_url = sys.argv[1] if len(sys.argv) > 1 else None
url = "https://www.youtube.com/watch?v=cCPsdFdlshc"

with Client(base_url=base_url) as v2c:
    health = v2c.health()
    print(f"server {health.version} on {health.runtime}, formats: {', '.join(f.id for f in health.formats)}")

    # 1. The outline is cheap: sections with token counts, so you read only what you need.
    outline = v2c.outline(url)
    print(f"\n{outline.metadata.title}: {outline.total_tokens} tokens")
    for ch in outline.chapters:
        print(f"  {ch.start_sec:7.1f}s  {ch.tokens:4d} tokens  {ch.title}")

    # 2. One section by time ("m:ss" strings or seconds), end exclusive.
    print("\n4:35 to 4:45:")
    print(v2c.section(url, start="4:35", end="4:45", timestamps=True))

    # 3. Errors carry a stable code, the HTTP status and a hint on how to recover.
    try:
        v2c.context("https://example.com/not-a-video")
    except Vid2ContextError as e:
        print(f"error: {e.code} (HTTP {e.status}): {e.hint}")

# 4. A cited answer from POST /ask.
api = (base_url or "http://127.0.0.1:8787").rstrip("/")
reply = httpx.post(
    f"{api}/api/v1/ask",
    json={"question": "Which engine do they call the most reliable?", "inputs": [url], "maxTokens": 400},
    timeout=300,
)
reply.raise_for_status()
answer = reply.json()
print(f"\n{answer['answer']}")
for c in answer["citations"]:
    print(f"  [{c['n']}] {c['startSec']:.0f}s {c.get('url', '')}")
print(f"answered by {answer['rung']}")
