"""Split a VideoContext into document-sized chunks with timestamp metadata.

Shared by the LangChain loader and the LlamaIndex reader so both produce the
same text and metadata. Chunk text is the raw transcript text of the segments
in that chunk (whitespace collapsed); nothing is summarized or rewritten.

Modes:
- "chapters": one chunk per chapter. A video without chapters falls back to
  "window", and the chunk's `chunking` metadata says so.
- "segments": one chunk per transcript segment (caption line).
- "window": consecutive chunks of about `window_sec` seconds. A window starts
  at its first segment and takes every following segment that starts before
  start + window_sec, so no window is empty and segments are never split.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Literal, Optional

from .errors import Vid2ContextError
from .models import Chapter, Segment, VideoContext, VideoRef

Chunking = Literal["chapters", "segments", "window"]
CHUNKING_MODES: tuple[str, ...] = ("chapters", "segments", "window")


@dataclass
class Chunk:
    text: str
    metadata: dict[str, Any]


def timestamp_url(ref: VideoRef, sec: float) -> Optional[str]:
    """A link that opens the media at `sec` (same rules as core `timestampUrl`)."""
    t = max(0, math.floor(sec))
    if ref.platform == "youtube" and ref.kind == "video":
        return f"https://www.youtube.com/watch?v={ref.native_id}&t={t}s"
    if ref.platform == "vimeo" and ref.url:
        return f"{ref.url}#t={t}s"
    if ref.url and re.match(r"^https?:", ref.url, re.IGNORECASE):
        return f"{ref.url}#t={t}"
    return None


def segments_text(segments: list[Segment]) -> str:
    """Join segment text with single spaces (same rules as core `segmentsToText`)."""
    return re.sub(r"\s+", " ", " ".join(t for t in (s.text.strip() for s in segments) if t)).strip()


def _base_metadata(ctx: VideoContext) -> dict[str, Any]:
    m = ctx.metadata
    t = ctx.transcript
    return {
        "source": m.ref.url or m.ref.input,
        "title": m.title,
        "channel": m.channel.name if m.channel else None,
        "video_id": m.ref.id,
        "platform": m.ref.platform,
        "transcript_origin": t.origin,
        "language": t.language,
        "published_at": m.published_at,
    }


def _chunk(ctx: VideoContext, base: dict[str, Any], segs: list[Segment], start: float, end: float, extra: dict[str, Any]) -> Chunk:
    meta = {**base, "start_sec": start, "end_sec": end, "url": timestamp_url(ctx.metadata.ref, start) or base["source"], **extra}
    # Vector stores (Chroma, Pinecone and others) reject None values, so leave unknown fields out.
    return Chunk(text=segments_text(segs), metadata={k: v for k, v in meta.items() if v is not None})


def _chapter_bounds(chapters: list[Chapter], i: int, fallback_end: float) -> tuple[float, float]:
    ch = chapters[i]
    nxt = chapters[i + 1].start_sec if i + 1 < len(chapters) else None
    end = ch.end_sec if ch.end_sec is not None else (nxt if nxt is not None else fallback_end)
    return ch.start_sec, max(end, ch.start_sec)


def by_chapters(ctx: VideoContext, window_sec: float = 60) -> list[Chunk]:
    chapters = sorted(ctx.metadata.chapters, key=lambda c: c.start_sec)
    if not chapters:
        return by_window(ctx, window_sec, fell_back=True)
    segs = ctx.transcript.segments
    last_end = max([s.end_sec for s in segs] + [ctx.metadata.duration_sec or 0])
    base = _base_metadata(ctx)
    out: list[Chunk] = []
    for i, ch in enumerate(chapters):
        start, end = _chapter_bounds(chapters, i, last_end)
        is_first, is_last = i == 0, i == len(chapters) - 1
        # Each segment belongs to the chapter its start falls in, so nothing is repeated;
        # text before the first chapter mark goes to the first chapter, text after the last mark to the last.
        mine = [
            s
            for s in segs
            if (is_first or s.start_sec >= start) and (is_last or s.start_sec < chapters[i + 1].start_sec)
        ]
        if not segments_text(mine):
            continue
        out.append(_chunk(ctx, base, mine, start, end, {"chunking": "chapters", "chapter": ch.title, "chapter_index": i}))
    return out


def by_segments(ctx: VideoContext) -> list[Chunk]:
    base = _base_metadata(ctx)
    return [
        _chunk(ctx, base, [s], s.start_sec, s.end_sec, {"chunking": "segments", "segment_index": i})
        for i, s in enumerate(ctx.transcript.segments)
        if s.text.strip()
    ]


def by_window(ctx: VideoContext, window_sec: float, fell_back: bool = False) -> list[Chunk]:
    if not window_sec > 0:
        raise Vid2ContextError("bad-request", f"window_sec must be positive, got {window_sec}.", hint="Use a value such as 60.")
    base = _base_metadata(ctx)
    extra: dict[str, Any] = {"chunking": "window"}
    if fell_back:
        extra["chunking_requested"] = "chapters"
    out: list[Chunk] = []
    current: list[Segment] = []
    for s in ctx.transcript.segments:
        if not s.text.strip():
            continue
        if current and s.start_sec >= current[0].start_sec + window_sec:
            out.append(_chunk(ctx, base, current, current[0].start_sec, current[-1].end_sec, {**extra, "window_index": len(out)}))
            current = []
        current.append(s)
    if current:
        out.append(_chunk(ctx, base, current, current[0].start_sec, current[-1].end_sec, {**extra, "window_index": len(out)}))
    return out


def chunk_context(ctx: VideoContext, chunking: str = "chapters", window_sec: float = 60) -> list[Chunk]:
    """Split one VideoContext. See the module docstring for the modes."""
    if chunking == "chapters":
        return by_chapters(ctx, window_sec)
    if chunking == "segments":
        return by_segments(ctx)
    if chunking == "window":
        return by_window(ctx, window_sec)
    raise Vid2ContextError(
        "bad-request", f'Unknown chunking "{chunking}".', hint=f"Use one of: {', '.join(CHUNKING_MODES)}."
    )
