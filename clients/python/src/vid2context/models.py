"""Typed mirrors of the vid2context core types (packages/core/src/types.ts).

Plain dataclasses, no pydantic. Each `from_dict` accepts the JSON the HTTP API
returns and ignores fields it does not know, so a newer server still parses.
The original JSON is kept on `VideoContext.raw`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional, Union

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
    """A transcript formatter. `extension` is present in GET /formats, not in health."""

    id: str
    description: str
    mime_type: str
    extension: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> FormatInfo:
        return cls(
            id=d.get("id", ""),
            description=d.get("description", ""),
            mime_type=d.get("mimeType", ""),
            extension=d.get("extension"),
        )


@dataclass
class OutlineChapter:
    """A chapter (or a five-minute section when the video has none) with its token estimate."""

    title: str
    start_sec: float
    end_sec: Optional[float]
    tokens: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> OutlineChapter:
        return cls(
            title=d.get("title", ""),
            start_sec=float(d.get("startSec", 0)),
            end_sec=_opt_float(d.get("endSec")),
            tokens=int(d.get("tokens", 0)),
        )


@dataclass
class Outline:
    """GET /api/v1/outline: pick the chapters you need, then fetch them with `section`."""

    metadata: VideoMetadata
    chapters: list[OutlineChapter]
    total_tokens: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Outline:
        return cls(
            metadata=VideoMetadata.from_dict(d.get("metadata", {})),
            chapters=[OutlineChapter.from_dict(c) for c in d.get("chapters", [])],
            total_tokens=int(d.get("totalTokens", 0)),
        )


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


# Search (GET /api/v1/search, packages/search/src/http.ts) and collections
# (/api/v1/collections, packages/library/src/http.ts).

SearchMode = Literal["hybrid", "keyword", "vector"]
Every = Union[Literal["hourly", "daily", "weekly"], dict[str, int]]
"""How often a watched collection refreshes: "hourly", "daily", "weekly" or {"minutes": n}."""


@dataclass
class SearchHit:
    """One matching passage. `url` opens the video at `start_sec` when the platform supports it."""

    video_id: str
    title: str
    start_sec: float
    end_sec: float
    text: str
    score: float
    snippet: str
    """A short part of `text` with matched words in **bold**."""
    sources: list[str] = field(default_factory=list)
    """Which side found it: "keyword", "vector" or both."""
    url: Optional[str] = None
    chapter_title: Optional[str] = None
    channel: Optional[str] = None
    ranks: dict[str, int] = field(default_factory=dict)
    rerank_score: Optional[float] = None
    """LLM relevance from 0 to 10, when the search was reranked."""

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SearchHit:
        return cls(
            video_id=d.get("videoId", ""),
            title=d.get("title", ""),
            start_sec=float(d.get("startSec", 0)),
            end_sec=float(d.get("endSec", 0)),
            text=d.get("text", ""),
            score=float(d.get("score", 0)),
            snippet=d.get("snippet", ""),
            sources=list(d.get("sources", [])),
            url=d.get("url"),
            chapter_title=d.get("chapterTitle"),
            channel=d.get("channel"),
            ranks=dict(d.get("ranks", {})),
            rerank_score=_opt_float(d.get("rerankScore")),
        )


@dataclass
class SearchMeta:
    """How the search ran. The full JSON (keyword backend, fusion, timings) is on `raw`."""

    mode: str
    vector: str
    """"ok", "partial", "disabled" (no embedding provider), "failed" or "off" (keyword mode)."""
    rerank: str
    indexed_videos: int
    indexed_chunks: int
    vector_reason: Optional[str] = None
    model: Optional[str] = None
    attempts: list[Attempt] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SearchMeta:
        indexed = d.get("indexed", {})
        return cls(
            mode=d.get("mode", ""),
            vector=d.get("vector", ""),
            rerank=d.get("rerank", ""),
            indexed_videos=int(indexed.get("videos", 0)),
            indexed_chunks=int(indexed.get("chunks", 0)),
            vector_reason=d.get("vectorReason"),
            model=d.get("model"),
            attempts=[Attempt.from_dict(a) for a in d.get("attempts", [])],
            raw=d,
        )


@dataclass
class SearchResult:
    hits: list[SearchHit]
    meta: SearchMeta

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SearchResult:
        return cls(hits=[SearchHit.from_dict(h) for h in d.get("hits", [])], meta=SearchMeta.from_dict(d.get("meta", {})))


@dataclass
class VideoSummary:
    """A saved video in the library, without its transcript."""

    id: str
    ref: VideoRef
    title: str
    origin: str
    language: str
    saved_at: str
    """ISO 8601."""
    channel: Optional[str] = None
    duration_sec: Optional[float] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> VideoSummary:
        return cls(
            id=d.get("id", ""),
            ref=VideoRef.from_dict(d.get("ref", {})),
            title=d.get("title", ""),
            origin=d.get("origin", ""),
            language=d.get("language", ""),
            saved_at=d.get("savedAt", ""),
            channel=d.get("channel"),
            duration_sec=_opt_float(d.get("durationSec")),
        )


@dataclass
class Collection:
    id: str
    name: str
    sources: list[str]
    """Playlist, channel or feed inputs the collection follows."""
    video_ids: list[str]
    created_at: str
    updated_at: str
    description: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Collection:
        return cls(
            id=d.get("id", ""),
            name=d.get("name", ""),
            sources=list(d.get("sources", [])),
            video_ids=list(d.get("videoIds", [])),
            created_at=d.get("createdAt", ""),
            updated_at=d.get("updatedAt", ""),
            description=d.get("description"),
        )


@dataclass
class Schedule:
    """A watch list schedule. Times are UTC."""

    every: Every
    at: Optional[str] = None
    """"HH:MM" (hourly schedules use only the minutes)."""
    enabled: bool = True

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Schedule:
        return cls(every=d.get("every", "daily"), at=d.get("at"), enabled=d.get("enabled", True) is not False)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"every": self.every, "enabled": self.enabled}
        if self.at is not None:
            out["at"] = self.at
        return out


@dataclass
class Watch:
    schedule: Schedule
    seen_ids: list[str] = field(default_factory=list)
    last_checked_at: Optional[str] = None
    next_due_at: Optional[str] = None
    last_error: Optional[dict[str, Any]] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Watch:
        state = d.get("state", {})
        return cls(
            schedule=Schedule.from_dict(d.get("schedule", {})),
            seen_ids=list(state.get("seenIds", [])),
            last_checked_at=state.get("lastCheckedAt"),
            next_due_at=state.get("nextDueAt"),
            last_error=state.get("lastError"),
        )


@dataclass
class CollectionDetail(Collection):
    """GET /collections/{id}: the collection plus its videos, pending imports and watch schedule."""

    videos: list[VideoSummary] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)
    """Video inputs from an import, ingested on the next refresh."""
    watch: Optional[Watch] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CollectionDetail:
        base = Collection.from_dict(d)
        watch = d.get("watch")
        return cls(
            **base.__dict__,
            videos=[VideoSummary.from_dict(v) for v in d.get("videos", [])],
            pending=list(d.get("pending", [])),
            watch=Watch.from_dict(watch) if isinstance(watch, dict) else None,
        )


@dataclass
class IngestFailure:
    input: str
    code: str
    message: str
    hint: Optional[str] = None
    cause: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> IngestFailure:
        return cls(
            input=d.get("input", ""),
            code=d.get("code", ""),
            message=d.get("message", ""),
            hint=d.get("hint"),
            cause=d.get("cause"),
        )


@dataclass
class RefreshSummary:
    """What one ingest or refresh run did. Failures are listed, never raised, so one bad video does not stop the rest."""

    collection_id: str
    added: list[VideoSummary]
    skipped: int
    failed: list[IngestFailure]
    remaining: int
    """New items left for the next run because of the item cap."""
    checked_at: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> RefreshSummary:
        return cls(
            collection_id=d.get("collectionId", ""),
            added=[VideoSummary.from_dict(v) for v in d.get("added", [])],
            skipped=int(d.get("skipped", 0)),
            failed=[IngestFailure.from_dict(f) for f in d.get("failed", [])],
            remaining=int(d.get("remaining", 0)),
            checked_at=d.get("checkedAt"),
        )


@dataclass
class IngestResult:
    """An ingest or refresh the server ran inline (no jobs queue): the updated collection and the run summary."""

    collection: Collection
    summary: RefreshSummary

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> IngestResult:
        return cls(collection=Collection.from_dict(d.get("collection", {})), summary=RefreshSummary.from_dict(d.get("summary", {})))


@dataclass
class Job:
    """A queued background job (202 Accepted). Its result is an `IngestResult` body once done (GET /api/v1/jobs/{id})."""

    id: str
    kind: str
    status: str
    """"queued", "running", "succeeded", "failed" or "canceled"."""
    created_at: str
    updated_at: str
    progress: Optional[dict[str, Any]] = None
    result: Any = None
    error: Optional[dict[str, Any]] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Job:
        return cls(
            id=d.get("id", ""),
            kind=d.get("kind", ""),
            status=d.get("status", ""),
            created_at=d.get("createdAt", ""),
            updated_at=d.get("updatedAt", ""),
            progress=d.get("progress"),
            result=d.get("result"),
            error=d.get("error"),
        )


@dataclass
class CollectionDefinition:
    """The portable definition export writes and import reads: sources and video URLs, no transcripts."""

    name: str
    sources: list[str]
    videos: list[str]
    description: Optional[str] = None
    schedule: Optional[Schedule] = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CollectionDefinition:
        schedule = d.get("schedule")
        return cls(
            name=d.get("name", ""),
            sources=list(d.get("sources", [])),
            videos=list(d.get("videos", [])),
            description=d.get("description"),
            schedule=Schedule.from_dict(schedule) if isinstance(schedule, dict) else None,
            raw=d,
        )

    def to_dict(self) -> dict[str, Any]:
        """The definition as JSON. Keeps the server's fields (format, version) when it came from an export."""
        out: dict[str, Any] = dict(self.raw) if self.raw else {"format": "vid2context.collection", "version": 1}
        out.update({"name": self.name, "sources": list(self.sources), "videos": list(self.videos)})
        if self.description is not None:
            out["description"] = self.description
        else:
            out.pop("description", None)
        if self.schedule is not None:
            out["schedule"] = self.schedule.to_dict()
        else:
            out.pop("schedule", None)
        return out


@dataclass
class ImportResult:
    collection: Collection
    summary: Optional[RefreshSummary] = None
    """Set when the import was asked to ingest right away (refresh=True)."""

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ImportResult:
        summary = d.get("summary")
        return cls(
            collection=Collection.from_dict(d.get("collection", {})),
            summary=RefreshSummary.from_dict(summary) if isinstance(summary, dict) else None,
        )
