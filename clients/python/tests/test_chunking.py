from __future__ import annotations

import json
import math

import pytest

from conftest import load
from vid2context import VideoContext, Vid2ContextError, chunk_context, segments_text, timestamp_url


def _ctx(name: str) -> VideoContext:
    return VideoContext.from_dict(json.loads(load(name)["body"]))


ZOO = _ctx("context-jNQXAC9IVRw")
GWAGON = _ctx("context-cCPsdFdlshc")


def test_chapters_put_each_segment_in_the_chapter_it_starts_in():
    chunks = chunk_context(ZOO, "chapters")
    # The last caption starts at 16.881 s, before the "End" chapter (17 s), so "End" has no text and is skipped.
    assert [c.metadata["chapter"] for c in chunks] == ["Intro", "The cool thing"]
    intro, cool = chunks
    assert intro.text == "All right, so here we are, in front of the elephants"
    assert (intro.metadata["start_sec"], intro.metadata["end_sec"]) == (0, 5)
    assert intro.metadata["url"] == "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s"
    assert (cool.metadata["start_sec"], cool.metadata["end_sec"]) == (5, 17)
    assert cool.metadata["url"] == "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s"
    assert cool.metadata["chapter_index"] == 1
    assert cool.text.startswith("the cool thing about these guys")
    assert cool.text.endswith("and that's pretty much all there is to say")
    # Nothing lost, nothing repeated.
    assert " ".join(c.text for c in chunks) == segments_text(ZOO.transcript.segments)


def test_metadata_fields():
    meta = chunk_context(ZOO, "chapters")[0].metadata
    assert meta == {
        "source": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        "title": "Me at the zoo",
        "channel": "jawed",
        "video_id": "youtube:jNQXAC9IVRw",
        "platform": "youtube",
        "transcript_origin": "creator-captions",
        "language": "en",
        "start_sec": 0,
        "end_sec": 5,
        "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s",
        "chunking": "chapters",
        "chapter": "Intro",
        "chapter_index": 0,
    }
    # No None values: published_at is unknown for this video, so it is left out.
    assert "published_at" not in meta


def test_chapters_fall_back_to_windows_without_chapters():
    chunks = chunk_context(GWAGON, "chapters", window_sec=120)
    assert all(c.metadata["chunking"] == "window" and c.metadata["chunking_requested"] == "chapters" for c in chunks)
    assert [c.text for c in chunks] == [c.text for c in chunk_context(GWAGON, "window", window_sec=120)]


def test_windows_cover_the_whole_transcript_in_order():
    segs = [s for s in GWAGON.transcript.segments if s.text.strip()]
    chunks = chunk_context(GWAGON, "window", window_sec=60)
    assert 17 <= len(chunks) <= 20  # 1084 s of video
    assert [c.metadata["window_index"] for c in chunks] == list(range(len(chunks)))
    assert " ".join(c.text for c in chunks) == segments_text(GWAGON.transcript.segments)
    assert chunks[0].metadata["start_sec"] == segs[0].start_sec
    assert chunks[-1].metadata["end_sec"] == segs[-1].end_sec
    for a, b in zip(chunks, chunks[1:]):
        # A window ends at its last caption and the next starts at least window_sec after it began.
        assert b.metadata["start_sec"] >= a.metadata["start_sec"] + 60
        assert a.metadata["end_sec"] <= b.metadata["start_sec"] + 5  # captions may overlap slightly
    for c in chunks:
        assert c.metadata["url"] == f"https://www.youtube.com/watch?v=cCPsdFdlshc&t={math.floor(c.metadata['start_sec'])}s"
        assert c.metadata["title"].startswith("Best & Worst G-Wagon Years")
        assert c.metadata["channel"] == "Alliance Motorworks"
        assert c.metadata["transcript_origin"] == "auto-captions"
        assert "chunking_requested" not in c.metadata


def test_segments_one_per_caption():
    chunks = chunk_context(ZOO, "segments")
    assert len(chunks) == 6
    assert [c.text for c in chunks] == [s.text.strip() for s in ZOO.transcript.segments]
    first = chunks[0].metadata
    assert (first["start_sec"], first["end_sec"], first["segment_index"]) == (1.2, 3.36, 0)
    assert first["url"] == "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s"


def test_invalid_options():
    with pytest.raises(Vid2ContextError) as e:
        chunk_context(ZOO, "paragraphs")
    assert e.value.code == "bad-request" and e.value.hint == "Use one of: chapters, segments, window."
    with pytest.raises(Vid2ContextError):
        chunk_context(ZOO, "window", window_sec=0)


def test_timestamp_url_matches_core():
    ref = ZOO.metadata.ref
    assert timestamp_url(ref, 75.9) == "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=75s"
    assert timestamp_url(ref, -3) == "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s"
