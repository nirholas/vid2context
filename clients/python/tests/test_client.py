from __future__ import annotations

import socket

import httpx
import pytest

from vid2context import AsyncClient, Client, Vid2ContextError

ZOO = "https://youtu.be/jNQXAC9IVRw"
GWAGON = "https://www.youtube.com/watch?v=cCPsdFdlshc"
APOLLO = "tests/fixtures/media/apollo11-small-step.mp3"


def test_health_lists_formats_and_providers(transport, replay):
    with Client("http://127.0.0.1:8787", transport=transport) as v2c:
        h = v2c.health()
    assert h.ok and h.name == "vid2context" and h.runtime == "node"
    assert [f.id for f in h.formats] == ["text", "json"]
    assert h.formats[0].mime_type == "text/plain; charset=utf-8"
    assert "youtube" in [p["id"] for p in h.providers]
    req = replay.requests[0]
    assert str(req.url) == "http://127.0.0.1:8787/api/v1/health"
    assert "authorization" not in req.headers


def test_context_parses_the_video_context(transport, replay):
    with Client(transport=transport) as v2c:
        ctx = v2c.context(ZOO)
    m = ctx.metadata
    assert m.title == "Me at the zoo"
    assert m.channel is not None and m.channel.name == "jawed"
    assert m.ref.id == "youtube:jNQXAC9IVRw" and m.ref.native_id == "jNQXAC9IVRw"
    assert m.duration_sec == 19
    assert [(c.title, c.start_sec, c.end_sec) for c in m.chapters] == [("Intro", 0, 5), ("The cool thing", 5, 17), ("End", 17, 19)]
    t = ctx.transcript
    assert (t.language, t.origin, t.producer) == ("en", "creator-captions", "youtube-captions")
    assert len(t.segments) == 6
    assert t.segments[0].text == "All right, so here we are, in front of the elephants"
    assert t.segments[0].start_sec == 1.2 and t.segments[0].end_sec == 3.36
    assert [(a.id, a.stage, a.outcome) for a in ctx.attempts] == [
        ("youtube", "resolve", "ok"),
        ("youtube", "metadata", "ok"),
        ("youtube-captions", "captions", "ok"),
    ]
    assert ctx.raw["metadata"]["title"] == "Me at the zoo"
    assert dict(replay.requests[0].url.params) == {"url": ZOO}


def test_context_of_a_long_auto_captioned_video(transport):
    with Client(transport=transport) as v2c:
        ctx = v2c.context(GWAGON)
    assert ctx.metadata.title.startswith("Best & Worst G-Wagon Years")
    assert ctx.metadata.chapters == []
    assert ctx.transcript.origin == "auto-captions"
    assert len(ctx.transcript.segments) == 521
    assert ctx.metadata.description is not None and "[email redacted]" in ctx.metadata.description


def test_transcript_in_the_server_format(transport, replay):
    with Client(transport=transport) as v2c:
        text = v2c.transcript(APOLLO)
        stamped = v2c.transcript(APOLLO, timestamps=True)
    # The body exactly as the server sent it, trailing newline included.
    assert text == "I'm going to step off the limb now. That's one small step for man, one giant leap for mankind.\n"
    assert stamped.splitlines() == [
        "[0:03] I'm going to step off the limb now.",
        "[0:14] That's one small step for man, one giant leap for mankind.",
    ]
    assert dict(replay.requests[0].url.params) == {"url": APOLLO}
    assert dict(replay.requests[1].url.params) == {"url": APOLLO, "timestamps": "1"}


def test_context_of_a_local_file_transcribed_by_speech_to_text(transport):
    with Client(transport=transport) as v2c:
        ctx = v2c.context(APOLLO)
    assert ctx.metadata.ref.platform == "file"
    assert ctx.metadata.title == "apollo11-small-step"
    t = ctx.transcript
    assert (t.origin, t.producer, t.model) == ("stt", "stt/ovh/whisper-large-v3-turbo", "whisper-large-v3-turbo")
    assert [s.text for s in t.segments] == [
        "I'm going to step off the limb now.",
        "That's one small step for man, one giant leap for mankind.",
    ]
    # Fields this client does not model yet (word timings) stay available on the raw JSON.
    assert ctx.raw["transcript"]["segments"][0]["words"][0]["word"] == "I'm"


def test_mode_and_lang_are_sent_as_query_parameters(make_replay):
    replay = make_replay(["context-jNQXAC9IVRw"])
    with Client(transport=httpx.MockTransport(replay)) as v2c, pytest.raises(AssertionError, match="no recorded response"):
        v2c.context(ZOO, mode="captions", lang="en")
    assert dict(replay.requests[0].url.params) == {"url": ZOO, "mode": "captions", "lang": "en"}


def test_base_url_and_key_come_from_env(monkeypatch, transport, replay):
    monkeypatch.setenv("VID2CONTEXT_API_URL", "http://10.0.0.5:9999/api/v1/")
    monkeypatch.setenv("VID2CONTEXT_API_KEY", "k-env")
    with Client(transport=transport) as v2c:
        assert v2c.base_url == "http://10.0.0.5:9999"
        v2c.health()
    assert str(replay.requests[0].url) == "http://10.0.0.5:9999/api/v1/health"
    assert replay.requests[0].headers["authorization"] == "Bearer k-env"


def test_explicit_key_wins_over_env(monkeypatch, transport, replay):
    monkeypatch.setenv("VID2CONTEXT_API_KEY", "k-env")
    with Client(api_key="k-arg", transport=transport) as v2c:
        v2c.health()
    assert replay.requests[0].headers["authorization"] == "Bearer k-arg"


def test_default_base_url(monkeypatch):
    monkeypatch.delenv("VID2CONTEXT_API_URL", raising=False)
    with Client() as v2c:
        assert v2c.base_url == "http://127.0.0.1:8787"


def test_empty_url_is_rejected_before_any_request(transport, replay):
    with Client(transport=transport) as v2c, pytest.raises(Vid2ContextError) as e:
        v2c.context("")
    assert e.value.code == "bad-request" and e.value.hint
    assert replay.requests == []


def _closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_unreachable_server_says_how_to_start_it():
    base = f"http://127.0.0.1:{_closed_port()}"
    with Client(base, timeout=5) as v2c, pytest.raises(Vid2ContextError) as e:
        v2c.health()
    assert e.value.code == "upstream"
    assert e.value.hint is not None and "npm run start:server" in e.value.hint


async def test_async_client(replay):
    async with AsyncClient(transport=httpx.MockTransport(replay)) as v2c:
        h = await v2c.health()
        ctx = await v2c.context(ZOO)
        with pytest.raises(Vid2ContextError) as e:
            await v2c.context("xxxxxxxxxxx")
    assert h.ok
    assert ctx.metadata.title == "Me at the zoo"
    assert e.value.code == "not-found" and e.value.status == 404
