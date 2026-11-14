/**
 * LangChain.js document loader backed by a vid2context server.
 *
 *   const docs = await new VideoContextLoader('https://youtu.be/jNQXAC9IVRw').load();
 */
import { BaseDocumentLoader } from '@langchain/core/document_loaders/base';
import { Document } from '@langchain/core/documents';
import { type TranscriptMode, Vid2ContextError } from '@vid2context/core';
import { type ApiOptions, fetchContext, fetchItems } from './api.ts';
import { CHUNKING_MODES, type Chunk, type Chunking, type ChunkMetadata, chunkContext } from './chunking.ts';

export interface VideoContextLoaderOptions extends ApiOptions {
  /** chapters (default), segments or window. */
  chunking?: Chunking;
  /** Window length in seconds for `window`, and for `chapters` on videos without chapters. Default 60. */
  windowSec?: number;
  /** Transcript mode for the server: auto, captions, stt or video. */
  mode?: TranscriptMode;
  /** Preferred transcript language, BCP-47. */
  lang?: string;
  /** Skip videos that fail instead of throwing. Each skip is reported to `onSkip`. */
  continueOnFailure?: boolean;
  /** Called for each skipped video when continueOnFailure is set. Default: one line on stderr. */
  onSkip?: (url: string, error: Vid2ContextError) => void;
  /**
   * Expand each URL through GET /items first, so a playlist, channel, feed or page loads every
   * video in it (a single video expands to itself). Off by default: plain video URLs cost one request each.
   */
  expand?: boolean;
  /** With expand, the most videos to take from each list. Default: the server's cap. */
  maxItems?: number;
}

function toDocument(chunk: Chunk, index: number): Document<ChunkMetadata> {
  // Stable ids, so loading the same video again lets a vector store upsert instead of duplicating.
  return new Document({
    id: `${chunk.metadata.video_id}#${chunk.metadata.chunking}-${index}`,
    pageContent: chunk.text,
    metadata: chunk.metadata,
  });
}

export class VideoContextLoader extends BaseDocumentLoader {
  readonly urls: string[];
  readonly options: VideoContextLoaderOptions;

  constructor(urls: string | string[], options: VideoContextLoaderOptions = {}) {
    super();
    this.urls = typeof urls === 'string' ? [urls] : [...urls];
    if (this.urls.length === 0)
      throw new Vid2ContextError('bad-request', 'No video URLs given.', { hint: 'Pass one URL or an array of URLs.' });
    const chunking = options.chunking ?? 'chapters';
    if (!CHUNKING_MODES.includes(chunking)) {
      throw new Vid2ContextError('bad-request', `Unknown chunking "${chunking}".`, {
        hint: `Use one of: ${CHUNKING_MODES.join(', ')}.`,
      });
    }
    const windowSec = options.windowSec ?? 60;
    if (!(windowSec > 0))
      throw new Vid2ContextError('bad-request', `windowSec must be positive, got ${windowSec}.`, {
        hint: 'Use a value such as 60.',
      });
    if (options.maxItems !== undefined && !(Number.isInteger(options.maxItems) && options.maxItems >= 1))
      throw new Vid2ContextError('bad-request', `maxItems must be a whole number of at least 1, got ${options.maxItems}.`, {
        hint: 'Use a value such as 50.',
      });
    this.options = options;
  }

  private skip(url: string, err: unknown): void {
    if (!this.options.continueOnFailure || !(err instanceof Vid2ContextError)) throw err;
    const onSkip = this.options.onSkip ?? ((u, e) => console.error(`[vid2context] skipped ${u}: ${e.message} [${e.code}]`));
    onSkip(url, err);
  }

  private async *videos(): AsyncGenerator<string> {
    for (const url of this.urls) {
      if (!this.options.expand) {
        yield url;
        continue;
      }
      let refs: Awaited<ReturnType<typeof fetchItems>>;
      try {
        refs = await fetchItems(url, { ...this.options, limit: this.options.maxItems });
      } catch (err) {
        this.skip(url, err);
        continue;
      }
      for (const ref of refs) yield ref.url ?? ref.input;
    }
  }

  /** Yield Documents one video at a time, so a long list never sits in memory at once. */
  async *lazyLoad(): AsyncGenerator<Document<ChunkMetadata>> {
    const { chunking = 'chapters', windowSec = 60 } = this.options;
    for await (const url of this.videos()) {
      let chunks: Chunk[];
      try {
        chunks = chunkContext(await fetchContext(url, this.options), chunking, windowSec);
      } catch (err) {
        this.skip(url, err);
        continue;
      }
      for (const [i, chunk] of chunks.entries()) yield toDocument(chunk, i);
    }
  }

  async load(): Promise<Document<ChunkMetadata>[]> {
    const docs: Document<ChunkMetadata>[] = [];
    for await (const doc of this.lazyLoad()) docs.push(doc);
    return docs;
  }
}
