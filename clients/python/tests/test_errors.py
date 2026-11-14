from __future__ import annotations

import pytest

from conftest import load
from vid2context import Client, Vid2ContextError
from vid2context.errors import error_from_body


def _raised(transport, call) -> Vid2ContextError:
    with Client(transport=transport) as v2c, pytest.raises(Vid2ContextError) as e:
        call(v2c)
    return e.value


def _from(name: str) -> Vid2ContextError:
    rec = load(name)
    return error_from_body(rec["status"], rec["body"])


def test_unavailable_video(transport):
    err = _raised(transport, lambda v: v.context("xxxxxxxxxxx"))
    assert err.code == "not-found" and err.status == 404
    assert err.message == "YouTube xxxxxxxxxxx: ERROR (This video is unavailable)"
    assert err.hint == "Check the video id or URL; the video may have been removed."
    assert [(a.id, a.stage, a.outcome, a.reason) for a in err.attempts] == [
        ("youtube", "resolve", "ok", None),
        ("youtube", "metadata", "error", "not-found"),
    ]
    assert str(err) == f"{err.message} (hint: {err.hint})"


def test_unknown_format_from_the_transcript_route(transport):
    err = _raised(transport, lambda v: v.transcript("https://youtu.be/jNQXAC9IVRw", format="pdf"))
    assert err.code == "bad-request" and err.status == 400
    assert err.message == 'Unknown format "pdf".'
    assert err.hint == "Available formats: text, json."
    assert err.attempts == []


def test_missing_url_body():
    err = _from("transcript-missing-url")
    assert (err.code, err.status, err.hint) == ("bad-request", 400, "Pass ?url=<video URL>.")


def test_blocked_by_youtube_keeps_every_attempt():
    err = _from("context-blocked")
    assert err.code == "no-transcript" and err.status == 422
    assert err.hint is not None and "attempts" in err.hint
    reasons = {a.id: a.reason for a in err.attempts}
    assert reasons["youtube-captions"] == "blocked"
    assert reasons["audio"] == "no-audio-provider"
    captions = next(a for a in err.attempts if a.id == "youtube-captions")
    assert captions.detail is not None and "429" in captions.detail
    assert isinstance(captions.ms, float)


def test_error_body_without_attempts_or_hint():
    # The server's 404 for an unknown route has no `attempts` and no `hint`.
    err = _from("route-not-found")
    assert err.code == "not-found" and err.status == 404
    assert err.hint is None and err.attempts == []
    assert "/api/v1/no-such-route" in err.message


def test_a_body_that_is_not_the_contract():
    # What a client sees when the base URL points at something that is not vid2context:
    # here the server's own transcript text served where an error body was expected.
    rec = load("transcript-jNQXAC9IVRw-text")
    err = error_from_body(502, rec["body"])
    assert err.code == "upstream" and err.status == 502
    assert err.hint is not None and "/api/v1/health" in err.hint
    assert rec["body"][:20] in err.message
