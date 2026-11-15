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
    from langchain_core.callbacks import AsyncCallbackManagerForRetrieverRun, CallbackManagerForRetrieverRun
    from langchain_core.document_loaders import BaseLoader
    from langchain_core.documents import Document
    from langchain_core.retrievers import BaseRetriever
    from pydantic import ConfigDict
except ImportError as e:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        'vid2context.langchain needs langchain-core. Install it with: pip install "vid2context[langchain]"'
    ) from e

from ._loading import Urls, VideoLoading, chunk_id, hit_metadata
from .chunking import Chunk, Chunking
from .client import AsyncClient, Client
from .models import SearchMode, SearchResult, TranscriptMode


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
        expand: Expand each URL through GET /items first, so a playlist, channel, feed or page
            loads every video in it (a single video expands to itself). Off by default, so plain
            video URLs cost one request each.
        max_items: With expand, the most videos to take from each list (default: the server's cap).

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
        expand: bool = False,
        max_items: Optional[int] = None,
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
            expand=expand,
            max_items=max_items,
        )

    def lazy_load(self) -> Iterator[Document]:
        """Yield Documents one video at a time, so a long list never sits in memory at once."""
        for index, chunk in self._loading.chunks():
            yield _document(chunk, index)

    async def alazy_load(self) -> AsyncIterator[Document]:
        async for index, chunk in self._loading.achunks():
            yield _document(chunk, index)


def _hit_documents(result: SearchResult) -> list[Document]:
    return [
        Document(id=f"{h.video_id}@{h.start_sec:g}", page_content=h.text, metadata=hit_metadata(h)) for h in result.hits
    ]


class VideoSearchRetriever(BaseRetriever):
    """Retrieve passages from videos saved in a vid2context server's library (GET /api/v1/search).

    >>> from vid2context.langchain import VideoSearchRetriever
    >>> docs = VideoSearchRetriever(collection_id=collection.id).invoke("which engine is most reliable")

    Each Document is one matching passage with metadata: source and url (a timestamp link),
    video_id, title, channel, chapter, start_sec, end_sec, score and search_sources. Add videos
    to the library first, for example with `Client.add_to_collection`.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    collection_id: Optional[str] = None
    video_ids: Optional[list[str]] = None
    limit: Optional[int] = None
    mode: Optional[SearchMode] = None
    rerank: bool = False
    client: Optional[Client] = None
    async_client: Optional[AsyncClient] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None

    def _search_kwargs(self) -> dict[str, object]:
        return {
            "collection_id": self.collection_id,
            "video_ids": self.video_ids,
            "limit": self.limit,
            "mode": self.mode,
            "rerank": self.rerank,
        }

    def _get_relevant_documents(self, query: str, *, run_manager: CallbackManagerForRetrieverRun) -> list[Document]:
        if self.client is not None:
            return _hit_documents(self.client.search(query, **self._search_kwargs()))  # type: ignore[arg-type]
        with Client(self.base_url, self.api_key) as client:
            return _hit_documents(client.search(query, **self._search_kwargs()))  # type: ignore[arg-type]

    async def _aget_relevant_documents(
        self, query: str, *, run_manager: AsyncCallbackManagerForRetrieverRun
    ) -> list[Document]:
        if self.async_client is not None:
            return _hit_documents(await self.async_client.search(query, **self._search_kwargs()))  # type: ignore[arg-type]
        async with AsyncClient(self.base_url, self.api_key) as client:
            return _hit_documents(await client.search(query, **self._search_kwargs()))  # type: ignore[arg-type]


__all__ = ["VideoContextLoader", "VideoSearchRetriever"]
