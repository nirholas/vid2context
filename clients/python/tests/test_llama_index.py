from __future__ import annotations

import httpx
from llama_index.core.schema import Document, MetadataMode

from vid2context import AsyncClient, Client
from vid2context.langchain import VideoContextLoader
from vid2context.llama_index import VideoContextReader

ZOO = "https://youtu.be/jNQXAC9IVRw"
GWAGON = "https://www.youtube.com/watch?v=cCPsdFdlshc"


def test_load_data_matches_the_langchain_loader(transport):
    client = Client(transport=transport)
    docs = VideoContextReader(client=client).load_data([ZOO, GWAGON])
    lc = VideoContextLoader([ZOO, GWAGON], client=client).load()
    assert all(isinstance(d, Document) for d in docs)
    assert [(d.id_, d.text, d.metadata) for d in docs] == [(d.id, d.page_content, d.metadata) for d in lc]


def test_citation_fields_stay_out_of_the_embedded_text(transport):
    doc = VideoContextReader(client=Client(transport=transport)).load_data(ZOO)[1]
    assert doc.metadata["url"] == "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s"
    embedded = doc.get_content(metadata_mode=MetadataMode.EMBED)
    assert "Me at the zoo" in embedded and "The cool thing" in embedded
    assert "youtube.com" not in embedded and "youtube:jNQXAC9IVRw" not in embedded
    assert "youtube.com" in doc.get_content(metadata_mode=MetadataMode.LLM)


def test_window_and_segments_chunking(transport):
    client = Client(transport=transport)
    windows = VideoContextReader(chunking="window", window_sec=300, client=client).load_data(GWAGON)
    assert 4 <= len(windows) <= 5  # 1084 s in windows of 300 s
    assert windows[0].metadata["window_index"] == 0 and windows[0].metadata["chunking"] == "window"
    segments = VideoContextReader(chunking="segments", client=client).load_data(ZOO)
    assert [d.metadata["segment_index"] for d in segments] == list(range(6))


async def test_aload_data(replay):
    reader = VideoContextReader(async_client=AsyncClient(transport=httpx.MockTransport(replay)))
    docs = await reader.aload_data([ZOO])
    assert [d.metadata["chapter"] for d in docs] == ["Intro", "The cool thing"]
