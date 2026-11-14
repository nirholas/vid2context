"""Typed mirrors of the vid2context core types (packages/core/src/types.ts).

Plain dataclasses, no pydantic. Each `from_dict` accepts the JSON the HTTP API
returns and ignores fields it does not know, so a newer server still parses.
The original JSON is kept on `VideoContext.raw`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

TranscriptMode = Literal["auto", "captions", "stt", "video"]
TranscriptOrigin = Literal["creator-captions", "auto-captions", "native-transcript", "stt", "video-model"]


def _opt_float(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


@dataclass
class VideoRef:
    """A resolved, canonical pointer to a piece of media."""

    input: str
    platform: str
    kind: str
    id: str
    native_id: str
    url: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> VideoRef:
        return cls(
            input=d.get("input", ""),
            platform=d.get("platform", ""),
            kind=d.get("kind", "video"),
            id=d.get("id", ""),
            native_id=d.get("nativeId", ""),
            url=d.get("url"),
        )


@dataclass
class Chapter:
    title: str
    start_sec: float
    end_sec: Optional[float] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Chapter:
        return cls(title=d.get("title", ""), start_sec=float(d.get("startSec", 0)), end_sec=_opt_float(d.get("endSec")))


@dataclass
class Channel:
    name: str
    id: Optional[str] = None
    url: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Channel:
        return cls(name=d.get("name", ""), id=d.get("id"), url=d.get("url"))


@dataclass
class VideoMetadata:
    ref: VideoRef
    title: str
    chapters: list[Chapter] = field(default_factory=list)
    channel: Optional[Channel] = None
    description: Optional[str] = None
    duration_sec: Optional[float] = None
    published_at: Optional[str] = None
    """ISO 8601."""
    thumbnail_url: Optional[str] = None
    language: Optional[str] = None
    tags: Optional[list[str]] = None
    is_live: Optional[bool] = None
    extra: Optional[dict[str, Any]] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> VideoMetadata:
        channel = d.get("channel")
        return cls(
            ref=VideoRef.from_dict(d.get("ref", {})),
            title=d.get("title", ""),
            chapters=[Chapter.from_dict(c) for c in d.get("chapters", [])],
            channel=Channel.from_dict(channel) if isinstance(channel, dict) else None,
            description=d.get("description"),
            duration_sec=_opt_float(d.get("durationSec")),
            published_at=d.get("publishedAt"),
            thumbnail_url=d.get("thumbnailUrl"),
            language=d.get("language"),
            tags=d.get("tags"),
            is_live=d.get("isLive"),
            extra=d.get("extra"),
        )


@dataclass
class Segment:
    """One timed piece of transcript text."""

    start_sec: float
    end_sec: float
    text: str
    speaker: Optional[str] = None
    confidence: Optional[float] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Segment:
        return cls(
            start_sec=float(d.get("startSec", 0)),
            end_sec=float(d.get("endSec", d.get("startSec", 0))),
            text=d.get("text", ""),
            speaker=d.get("speaker"),
            confidence=_opt_float(d.get("confidence")),
        )


@dataclass
class Transcript:
    ref: VideoRef
    language: str
    origin: str
    """One of TranscriptOrigin."""
    producer: str
    segments: list[Segment]
    created_at: str
    model: Optional[str] = None
    translated: Optional[bool] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Transcript:
        return cls(
            ref=VideoRef.from_dict(d.get("ref", {})),
            language=d.get("language", ""),
            origin=d.get("origin", ""),
            producer=d.get("producer", ""),
            segments=[Segment.from_dict(s) for s in d.get("segments", [])],
            created_at=d.get("createdAt", ""),
            model=d.get("model"),
            translated=d.get("translated"),
        )


@dataclass
class VisualNote:
    at_sec: float
    kind: str
    text: str
    producer: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> VisualNote:
        return cls(
            at_sec=float(d.get("atSec", 0)), kind=d.get("kind", ""), text=d.get("text", ""), producer=d.get("producer", "")
        )


@dataclass
class Comment:
    id: str
    author: str
    text: str
    likes: Optional[int] = None
    published_at: Optional[str] = None
    is_creator: Optional[bool] = None
    is_pinned: Optional[bool] = None
    replies: list[Comment] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Comment:
        return cls(
            id=d.get("id", ""),
            author=d.get("author", ""),
            text=d.get("text", ""),
            likes=d.get("likes"),
            published_at=d.get("publishedAt"),
            is_creator=d.get("isCreator"),
            is_pinned=d.get("isPinned"),
            replies=[Comment.from_dict(r) for r in d.get("replies", [])],
        )


@dataclass
class Attempt:
    """One provider or rung the server tried, in order."""

    id: str
    stage: str
    outcome: str
    """'ok', 'skipped', 'empty' or 'error'."""
    reason: Optional[str] = None
    detail: Optional[str] = None
    ms: Optional[float] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Attempt:
        return cls(
            id=d.get("id", ""),
            stage=d.get("stage", ""),
            outcome=d.get("outcome", ""),
            reason=d.get("reason"),
            detail=d.get("detail"),
            ms=_opt_float(d.get("ms")),
        )


@dataclass
class VideoContext:
    """Everything vid2context knows about one video."""

    metadata: VideoMetadata
    transcript: Transcript
    attempts: list[Attempt]
    visual: Optional[list[VisualNote]] = None
    comments: Optional[list[Comment]] = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)
    """The JSON body exactly as the server returned it."""

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> VideoContext:
        visual = d.get("visual")
        comments = d.get("comments")
        return cls(
            metadata=VideoMetadata.from_dict(d.get("metadata", {})),
            transcript=Transcript.from_dict(d.get("transcript", {})),
            attempts=[Attempt.from_dict(a) for a in d.get("attempts", [])],
            visual=[VisualNote.from_dict(v) for v in visual] if isinstance(visual, list) else None,
            comments=[Comment.from_dict(c) for c in comments] if isinstance(comments, list) else None,
            raw=d,
        )


@dataclass
class FormatInfo:
    id: str
    description: str
    mime_type: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> FormatInfo:
        return cls(id=d.get("id", ""), description=d.get("description", ""), mime_type=d.get("mimeType", ""))


@dataclass
class Health:
    """GET /api/v1/health. `providers` is kept as the server's JSON (ids, kinds, rungs, required env var names)."""

    ok: bool
    name: str
    version: str
    runtime: str
    formats: list[FormatInfo]
    providers: list[dict[str, Any]]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Health:
        return cls(
            ok=bool(d.get("ok")),
            name=d.get("name", ""),
            version=d.get("version", ""),
            runtime=d.get("runtime", ""),
            formats=[FormatInfo.from_dict(f) for f in d.get("formats", [])],
            providers=list(d.get("providers", [])),
        )
