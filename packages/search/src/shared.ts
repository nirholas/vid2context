/**
 * Helpers shared by the HTTP and MCP surfaces: one engine per storage
 * backend (so the in-memory indexes survive across requests), and a compact
 * text rendering of results for agents.
 */
import { type Ctx, MemoryStorage, type Registry, type Storage } from '@vid2context/core';
import { createSearchEngine, type SearchEngine, type SearchEngineOptions, type SearchResult } from './engine.ts';

/** Where the library comes from: a Storage, a per-call factory (the HTTP server's `storage(ctx)`), or omitted for the registry's enabled storage provider. */
export type StorageSource = Storage | null | ((ctx: Ctx) => Promise<Storage | null>);

export type EngineSettings = Omit<SearchEngineOptions, 'registry' | 'storage' | 'ctx'>;

const engines = new WeakMap<Storage, SearchEngine>();
/** Fallback library per registry when no storage backend is configured (process-local, lost on restart). */
const fallbackStorage = new WeakMap<Registry, MemoryStorage>();

export async function resolveStorage(registry: Registry, source: StorageSource | undefined, ctx: Ctx): Promise<Storage> {
  let storage: Storage | null;
  if (source === undefined) storage = await registry.openStorage(ctx);
  else if (typeof source === 'function') storage = await source(ctx);
  else storage = source;
  if (storage) return storage;
  let mem = fallbackStorage.get(registry);
  if (!mem) {
    mem = new MemoryStorage();
    fallbackStorage.set(registry, mem);
  }
  return mem;
}

/** The engine for a storage backend, created on first use and reused after. */
export function engineFor(registry: Registry, storage: Storage, ctx: Ctx, settings: EngineSettings = {}): SearchEngine {
  let engine = engines.get(storage);
  if (!engine) {
    engine = createSearchEngine({ ...settings, registry, storage, ctx });
    engines.set(storage, engine);
  }
  return engine;
}

/** 75 -> "1:15", 3725 -> "1:02:05". */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Markdown for agents: one block per hit with title, [m:ss-m:ss], link and the highlighted snippet, then a status line. */
export function renderResults(result: SearchResult): string {
  const { hits, meta } = result;
  const lines: string[] = [];
  if (hits.length === 0) {
    lines.push(`No matches for "${meta.query.text || meta.query.excluded.join(' ')}".`);
  }
  hits.forEach((h, i) => {
    const range = `[${formatTime(h.startSec)}-${formatTime(h.endSec)}]`;
    const chapter = h.chapterTitle ? ` (chapter: ${h.chapterTitle})` : '';
    lines.push(`${i + 1}. ${h.title} ${range}${chapter}`);
    if (h.url) lines.push(`   ${h.url}`);
    lines.push(`   ${h.snippet}`);
    lines.push('');
  });
  const sides = [
    meta.keyword.ran ? `keyword (${meta.keyword.backend})` : null,
    meta.vector === 'ok' || meta.vector === 'partial' ? `vector (${meta.model})` : null,
  ]
    .filter(Boolean)
    .join(' + ');
  const notes = [
    `searched ${meta.indexed.videos} videos with ${sides || 'nothing'}`,
    meta.vector === 'disabled' ? `vector search disabled: ${meta.vectorReason}` : null,
    meta.vector === 'failed' || meta.vector === 'partial' ? meta.vectorReason : null,
    meta.rerank === 'ok' && meta.rerankRung ? `reranked by ${meta.rerankRung}` : null,
    meta.rerank === 'failed' ? `rerank failed: ${meta.rerankReason}` : null,
    meta.reindexed?.length ? `re-indexed ${meta.reindexed.length} videos for model ${meta.reindexed[0]?.to}` : null,
  ].filter(Boolean);
  lines.push(`(${notes.join('; ')})`);
  return lines.join('\n').trim();
}
