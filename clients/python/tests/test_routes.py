"""The video routes beyond context and transcript: metadata, outline, section, items and formats,
plus playlist expansion in the loaders. Every response is a real recording (tests/fixtures/README.md)."""

from __future__ import annotations

import logging

import httpx
import pytest
from langchain_core.documents import Document

from vid2context import AsyncClient, Client, Vid2ContextError
from vid2context.langchain import VideoContextLoader
from vid2context.llama_index import VideoContextReader

ZOO = "https://youtu.be/jNQXAC9IVRw"
GWAGON = "https://www.youtube.com/watch?v=cCPsdFdlshc"
APOLLO = "tests/fixtures/media/apollo11-small-step.mp3"


def test_formats_include_extensions(transport, replay):
    with Client(transport=transport) as v2c:
        formats = v2c.formats()
    ids = [f.id for f in formats]
    assert ids[:2] == ["text", "json"] and "markdown" in ids
    text = formats[0]
    assert (text.mime_type, text.extension) == ("text/plain; charset=utf-8", "txt")
    assert replay.requests[0].url.path == "/api/v1/formats"


def test_metadata_without_a_transcript(transport, replay):
    with Client(transport=transport) as v2c:
        m = v2c.metadata(ZOO)
    assert m.title == "Me at the zoo"
    assert m.ref.id == "youtube:jNQXAC9IVRw"
    assert m.channel is not None and m.channel.name == "jawed"
    assert dict(replay.requests[0].url.params) == {"url": ZOO}


def test_outline_has_sections_with_token_counts(transport):
    with Client(transport=transport) as v2c:
        o = v2c.outline(APOLLO)
    assert o.metadata.title == "apollo11-small-step"
    # No chapters in the file, so the server makes one section per five minutes.
    assert len(o.chapters) == 1
    c = o.chapters[0]
    assert (c.title, c.start_sec) == ("0:00 to 0:24", 0)
    assert c.end_sec is not None and 24 < c.end_sec < 25
    assert c.tokens > 0 and o.total_tokens >= c.tokens


def test_section_by_chapter_and_by_range(transport, replay):
    with Client(transport=transport) as v2c:
        chapter = v2c.section(APOLLO, chapter=0)
        ranged = v2c.section(APOLLO, start=0.0, end="0:06", timestamps=True)
    assert chapter == "I'm going to step off the limb now. That's one small step for man, one giant leap for mankind.\n"
    # The range ends at 6 s, so only the first line is in it.
    assert ranged == "[0:03] I'm going to step off the limb now.\n"
    assert dict(replay.requests[0].url.params) == {"url": APOLLO, "chapter": "0"}
    assert dict(replay.requests[1].url.params) == {"url": APOLLO, "from": "0", "to": "0:06", "timestamps": "1"}


def test_section_without_a_selector_reports_the_server_hint(transport):
    with Client(transport=transport) as v2c, pytest.raises(Vid2ContextError) as e:
        v2c.section(ZOO)
    err = e.value
    assert (err.code, err.status, err.message) == ("bad-request", 400, "Pass from, to or chapter.")
    assert err.hint is not None and "?chapter=2" in err.hint
    assert err.attempts == []


def test_section_rejects_a_bool_time(transport, replay):
    with Client(transport=transport) as v2c, pytest.raises(TypeError):
        v2c.section(APOLLO, start=True)
    assert replay.requests == []


def test_items_of_a_single_video_and_a_local_file(transport):
    with Client(transport=transport) as v2c:
        [zoo] = v2c.items(ZOO)
        [apollo] = v2c.items(APOLLO)
    assert (zoo.id, zoo.input, zoo.url) == ("youtube:jNQXAC9IVRw", ZOO, "https://www.youtube.com/watch?v=jNQXAC9IVRw")
    assert apollo.platform == "file" and apollo.input == APOLLO
    assert apollo.url is not None and apollo.url.startswith("file://")


def test_items_limit_is_sent(make_replay):
    replay = make_replay(["items-jNQXAC9IVRw"])
    with Client(transport=httpx.MockTransport(replay)) as v2c, pytest.raises(AssertionError, match="no recorded response"):
        v2c.items(ZOO, limit=5)
    assert dict(replay.requests[0].url.params) == {"url": ZOO, "limit": "5"}


async def test_async_routes(replay):
    async with AsyncClient(transport=httpx.MockTransport(replay)) as v2c:
        formats = await v2c.formats()
        meta = await v2c.metadata(ZOO)
        outline = await v2c.outline(APOLLO)
        section = await v2c.section(APOLLO, chapter=0)
        items = await v2c.items(GWAGON)
    assert formats[0].extension == "txt"
    assert meta.title == "Me at the zoo"
    assert outline.total_tokens > 0
    assert section.startswith("I'm going to step off the limb now.")
    assert [i.id for i in items] == ["youtube:cCPsdFdlshc"]


def test_loader_expands_through_items_then_loads_each_video(transport, replay):
    docs = VideoContextLoader(GWAGON, chunking="window", expand=True, client=Client(transport=transport)).load()
    assert [(r.url.path, dict(r.url.params)) for r in replay.requests] == [
        ("/api/v1/items", {"url": GWAGON}),
        ("/api/v1/context", {"url": GWAGON}),
    ]
    assert all(isinstance(d, Document) for d in docs)
    assert {d.metadata["video_id"] for d in docs} == {"youtube:cCPsdFdlshc"}
    assert 17 <= len(docs) <= 20


def test_loader_skips_a_list_that_cannot_be_expanded(transport, replay, caplog):
    loader = VideoContextLoader(
        ["https://example.com/", GWAGON], expand=True, continue_on_failure=True, client=Client(transport=transport)
    )
    with caplog.at_level(logging.WARNING, logger="vid2context"):
        docs = loader.load()
    assert [r.url.path for r in replay.requests] == ["/api/v1/items", "/api/v1/items", "/api/v1/context"]
    assert {d.metadata["video_id"] for d in docs} == {"youtube:cCPsdFdlshc"}
    assert "skipped https://example.com/" in caplog.text and "unsupported-input" in caplog.text


def test_loader_raises_an_expansion_error_by_default(transport):
    with pytest.raises(Vid2ContextError) as e:
        VideoContextLoader("https://example.com/", expand=True, client=Client(transport=transport)).load()
    assert (e.value.code, e.value.status) == ("unsupported-input", 400)
    assert e.value.hint is not None


def test_loader_sends_max_items_as_the_items_limit(make_replay):
    replay = make_replay(["items-cCPsdFdlshc"])
    loader = VideoContextLoader(GWAGON, expand=True, max_items=10, client=Client(transport=httpx.MockTransport(replay)))
    with pytest.raises(AssertionError, match="no recorded response"):
        loader.load()
    assert dict(replay.requests[0].url.params) == {"url": GWAGON, "limit": "10"}


def test_loader_rejects_a_bad_max_items():
    with pytest.raises(Vid2ContextError) as e:
        VideoContextLoader(GWAGON, expand=True, max_items=0)
    assert e.value.code == "bad-request" and e.value.hint


async def test_reader_expands_asynchronously(replay):
    reader = VideoContextReader(chunking="window", expand=True, async_client=AsyncClient(transport=httpx.MockTransport(replay)))
    docs = await reader.aload_data([GWAGON])
    assert [r.url.path for r in replay.requests] == ["/api/v1/items", "/api/v1/context"]
    assert {d.metadata["video_id"] for d in docs} == {"youtube:cCPsdFdlshc"}
