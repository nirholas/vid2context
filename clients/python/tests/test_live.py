"""Live test against a vid2context server you started yourself.

    LIVE=1 VID2CONTEXT_API_URL=http://127.0.0.1:8787 uv run pytest tests/test_live.py -s

Starts nothing; skipped unless both variables are set.
"""

from __future__ import annotations

import json
import os
import sys

import pytest

from vid2context import Client
from vid2context.langchain import VideoContextLoader

pytestmark = pytest.mark.skipif(
    not (os.environ.get("LIVE") and os.environ.get("VID2CONTEXT_API_URL")),
    reason="set LIVE=1 and VID2CONTEXT_API_URL to run against a real server",
)

GWAGON = "https://www.youtube.com/watch?v=cCPsdFdlshc"


def test_live_health():
    with Client() as v2c:
        h = v2c.health()
    assert h.ok and "text" in [f.id for f in h.formats]


def test_live_loader_loads_the_gwagon_video():
    docs = VideoContextLoader(GWAGON, chunking="chapters").load()
    assert docs, "no documents"
    first = docs[0]
    assert first.page_content
    assert first.metadata["video_id"] == "youtube:cCPsdFdlshc"
    assert first.metadata["url"].startswith("https://www.youtube.com/watch?v=cCPsdFdlshc&t=")
    assert first.metadata["chunking"] in ("chapters", "window")
    print(f"\n{len(docs)} documents; first metadata:\n{json.dumps(first.metadata, indent=2)}", file=sys.stderr)
