from __future__ import annotations

import logging
from types import GeneratorType

import httpx
import pytest
from langchain_core.documents import Document

from vid2context import AsyncClient, Client, Vid2ContextError
from vid2context.langchain import VideoContextLoader

ZOO = "https://youtu.be/jNQXAC9IVRw"
GWAGON = "https://www.youtube.com/watch?v=cCPsdFdlshc"


def test_load_returns_documents_with_timestamp_metadata(transport):
    docs = VideoContextLoader(ZOO, client=Client(transport=transport)).load()
    assert all(isinstance(d, Document) for d in docs)
    assert [d.metadata["chapter"] for d in docs] == ["Intro", "The cool thing"]
    first = docs[0]
    assert first.page_content == "All right, so here we are, in front of the elephants"
    assert first.id == "youtube:jNQXAC9IVRw#chapters-0"
    for key in ("source", "title", "channel", "video_id", "start_sec", "end_sec", "url", "transcript_origin", "language"):
        assert key in first.metadata
    assert first.metadata["url"] == "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s"


def test_lazy_load_fetches_one_video_at_a_time(transport, replay):
    loader = VideoContextLoader([ZOO, GWAGON], chunking="window", window_sec=60, client=Client(transport=transport))
    it = loader.lazy_load()
    assert isinstance(it, GeneratorType)
    first = next(it)
    assert first.metadata["video_id"] == "youtube:jNQXAC9IVRw"
    # Only the first video has been fetched so far.
    assert [r.url.params["url"] for r in replay.requests] == [ZOO]
    rest = list(it)
    assert [r.url.params["url"] for r in replay.requests] == [ZOO, GWAGON]
    gwagon = [d for d in rest if d.metadata["video_id"] == "youtube:cCPsdFdlshc"]
    assert 17 <= len(gwagon) <= 20
    assert all(d.metadata["chunking"] == "window" for d in gwagon)
    assert [d.id for d in gwagon[:2]] == ["youtube:cCPsdFdlshc#window-0", "youtube:cCPsdFdlshc#window-1"]


def test_segments_chunking(transport):
    docs = VideoContextLoader(ZOO, chunking="segments", client=Client(transport=transport)).load()
    assert len(docs) == 6
    assert docs[3].page_content == "and that's cool"
    assert docs[3].metadata["segment_index"] == 3


def test_failures_raise_by_default(transport):
    with pytest.raises(Vid2ContextError) as e:
        VideoContextLoader(["xxxxxxxxxxx", ZOO], client=Client(transport=transport)).load()
    assert e.value.code == "not-found"


def test_continue_on_failure_skips_and_logs(transport, caplog):
    caplog.set_level(logging.WARNING, logger="vid2context")
    docs = VideoContextLoader(["xxxxxxxxxxx", ZOO], client=Client(transport=transport), continue_on_failure=True).load()
    assert {d.metadata["video_id"] for d in docs} == {"youtube:jNQXAC9IVRw"}
    assert "skipped xxxxxxxxxxx" in caplog.text and "[not-found]" in caplog.text


def test_options_are_checked_up_front():
    with pytest.raises(Vid2ContextError):
        VideoContextLoader(ZOO, chunking="pages")  # type: ignore[arg-type]
    with pytest.raises(Vid2ContextError):
        VideoContextLoader([])
    with pytest.raises(Vid2ContextError):
        VideoContextLoader(ZOO, chunking="window", window_sec=-1)


async def test_async_load_matches_sync(replay):
    docs = await VideoContextLoader([ZOO, GWAGON], async_client=AsyncClient(transport=httpx.MockTransport(replay))).aload()
    sync_docs = VideoContextLoader([ZOO, GWAGON], client=Client(transport=httpx.MockTransport(replay))).load()
    assert [(d.id, d.page_content, d.metadata) for d in docs] == [(d.id, d.page_content, d.metadata) for d in sync_docs]
    assert docs[-1].metadata["chunking_requested"] == "chapters"
