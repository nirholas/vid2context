"""LangChain document loader: `pip install "vid2context[langchain]"`.

>>> from vid2context.langchain import VideoContextLoader
>>> docs = VideoContextLoader("https://youtu.be/jNQXAC9IVRw").load()
>>> docs[0].metadata["url"]
'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s'
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from typing import Optional

try:
    from langchain_core.document_loaders import BaseLoader
    from langchain_core.documents import Document
except ImportError as e:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        'vid2context.langchain needs langchain-core. Install it with: pip install "vid2context[langchain]"'
    ) from e

from ._loading import Urls, VideoLoading, chunk_id
from .chunking import Chunk, Chunking
from .client import AsyncClient, Client
from .models import TranscriptMode


def _document(chunk: Chunk, index: int) -> Document:
    return Document(id=chunk_id(chunk, index), page_content=chunk.text, metadata=chunk.metadata)


class VideoContextLoader(BaseLoader):
    """Load videos as LangChain Documents through a vid2context server.

    Args:
        urls: One video URL (or YouTube id, or local path the server can read) or a list of them.
        chunking: "chapters" (default; one Document per chapter, or per window when a video has
            no chapters), "segments" (one per caption line) or "window" (about `window_sec` each).
        window_sec: Window length in seconds for "window", and for "chapters" on videos without chapters.
        mode: Transcript mode for the server: "auto", "captions", "stt" or "video".
        lang: Preferred transcript language (BCP-47, such as "en" or "pt-BR").
        continue_on_failure: Log and skip videos that fail instead of raising.
        client: A `vid2context.Client` to reuse (else one is made from base_url and api_key).
        async_client: A `vid2context.AsyncClient` for `alazy_load` and `aload`.
        base_url: Server URL; default VID2CONTEXT_API_URL or http://127.0.0.1:8787.
        api_key: Bearer key; default VID2CONTEXT_API_KEY.

    Metadata on every Document: source, title, channel, video_id, platform, start_sec, end_sec,
    url (a timestamp link), transcript_origin, language, chunking, plus chapter and chapter_index,
    segment_index or window_index for the mode. Fields the server does not know are left out.
    """

    def __init__(
        self,
        urls: Urls,
        chunking: Chunking = "chapters",
        window_sec: float = 60,
        client: Optional[Client] = None,
        *,
        mode: Optional[TranscriptMode] = None,
        lang: Optional[str] = None,
        continue_on_failure: bool = False,
        async_client: Optional[AsyncClient] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> None:
        self._loading = VideoLoading(
            urls,
            chunking=chunking,
            window_sec=window_sec,
            mode=mode,
            lang=lang,
            continue_on_failure=continue_on_failure,
            client=client,
            async_client=async_client,
            base_url=base_url,
            api_key=api_key,
        )

    def lazy_load(self) -> Iterator[Document]:
        """Yield Documents one video at a time, so a long list never sits in memory at once."""
        for index, chunk in self._loading.chunks():
            yield _document(chunk, index)

    async def alazy_load(self) -> AsyncIterator[Document]:
        async for index, chunk in self._loading.achunks():
            yield _document(chunk, index)


__all__ = ["VideoContextLoader"]
