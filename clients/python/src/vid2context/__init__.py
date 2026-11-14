"""Python client for the vid2context HTTP API.

The core of vid2context is TypeScript; this package is a thin client for a
server you run (`npm run start:server`). LangChain and LlamaIndex loaders live
in `vid2context.langchain` and `vid2context.llama_index` (optional extras).
"""

from .chunking import Chunk, Chunking, chunk_context, segments_text, timestamp_url
from .client import DEFAULT_BASE_URL, DEFAULT_TIMEOUT, AsyncClient, Client, TimeArg
from .errors import Vid2ContextError
from .models import (
    Attempt,
    Channel,
    Chapter,
    Comment,
    FormatInfo,
    Health,
    Outline,
    OutlineChapter,
    Segment,
    Transcript,
    TranscriptMode,
    TranscriptOrigin,
    VideoContext,
    VideoMetadata,
    VideoRef,
    VisualNote,
)

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT",
    "AsyncClient",
    "Attempt",
    "Channel",
    "Chapter",
    "Chunk",
    "Chunking",
    "Client",
    "Comment",
    "FormatInfo",
    "Health",
    "Outline",
    "OutlineChapter",
    "Segment",
    "TimeArg",
    "Transcript",
    "TranscriptMode",
    "TranscriptOrigin",
    "Vid2ContextError",
    "VideoContext",
    "VideoMetadata",
    "VideoRef",
    "VisualNote",
    "chunk_context",
    "segments_text",
    "timestamp_url",
]
