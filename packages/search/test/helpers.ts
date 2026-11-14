/**
 * Test helpers. The foundation ships no embedding provider yet (prompt 29
 * owns those), so tests use this minimal EmbedRung for the keyless OVH
 * bge-m3 endpoint and replay responses recorded from it by
 * scripts/record-fixtures.ts. It is test code only; src/ ships no embedding
 * client.
 */
import { readFileSync } from 'node:fs';
import {
  type EmbedProvider,
  type EmbedRung,
  errorFromResponse,
  type KvStore,
  MemoryKv,
  MemoryStorage,
  MemoryVectors,
  type Provider,
  Registry,
  type VectorHit,
  type VectorQuery,
  type VectorRecord,
  type VectorStore,
  type VideoContext,
} from '@vid2context/core';
import type { Route } from '@vid2context/core/testing';

export const OVH_EMBED_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings';
export const EMBED_FIXTURE = new URL('./fixtures/embeddings-ovh-bge-m3.json', import.meta.url);

/** Decode an OpenAI-style base64 embedding (little-endian float32). */
export function decodeBase64Embedding(b64: string): number[] {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Array.from(new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4)));
}

export function ovhEmbedRung(model = 'bge-m3'): EmbedRung {
  return {
    id: `embed/ovh/${model}`,
    provider: 'search-test-ovh-embed',
    service: 'ovh',
    model,
    tier: 'keyless',
    priority: 10,
    quality: 3,
    capabilities: [],
    requires: [],
    dimensions: 1024,
    async embed(texts, ctx) {
      const res = await ctx.fetch(OVH_EMBED_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts, encoding_format: 'base64' }),
        signal: ctx.signal,
      });
      if (!res.ok) throw await errorFromResponse(res, `OVH embeddings (${model})`);
      const json = (await res.json()) as { data: { index: number; embedding: string | number[] }[] };
      return [...json.data]
        .sort((a, b) => a.index - b.index)
        .map((d) => (typeof d.embedding === 'string' ? decodeBase64Embedding(d.embedding) : d.embedding));
    },
  };
}

export function embedProvider(rungs: EmbedRung[]): EmbedProvider {
  return { id: 'search-test-embed', kind: 'embed', name: 'Search test embeddings', runtimes: ['node'], rungs: () => rungs };
}

export function registryWith(providers: Provider[]): Registry {
  return new Registry(providers, 'node');
}

export function loadContext(file: string): VideoContext {
  return JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8')) as VideoContext;
}

export const GWAGON = 'youtube-cCPsdFdlshc.json';
export const ZOO = 'youtube-jNQXAC9IVRw.json';

export interface RecordedEmbedCall {
  input: string[];
  status: number;
  /** The response body exactly as the endpoint returned it. */
  body: string;
}

export interface EmbedFixture {
  endpoint: string;
  model: string;
  encoding: 'base64';
  recordedAt: string;
  calls: RecordedEmbedCall[];
}

export const SECOND_MODEL = 'bge-multilingual-gemma2';
export const SECOND_FIXTURE = new URL('./fixtures/embeddings-ovh-gemma2-zoo.json', import.meta.url);

export function loadEmbedFixture(file: URL = EMBED_FIXTURE): EmbedFixture {
  return JSON.parse(readFileSync(file, 'utf8')) as EmbedFixture;
}

/**
 * A replayFetch route serving recorded embedding responses: the request's
 * model and `input` list must equal a recorded call's exactly (same texts,
 * same batch), so a change to chunking shows up as a missing recording
 * instead of silently wrong vectors.
 */
export function embedRoute(...fixtures: EmbedFixture[]): Route {
  const byKey = new Map(fixtures.flatMap((f) => f.calls.map((c) => [`${f.model}\u0000${JSON.stringify(c.input)}`, c] as const)));
  return {
    method: 'POST',
    url: OVH_EMBED_URL,
    response: (call) => {
      const body = JSON.parse(String(call.body)) as { model: string; input: string[] };
      const rec = byKey.get(`${body.model}\u0000${JSON.stringify(body.input)}`);
      if (!rec) {
        throw new Error(
          `No recorded ${body.model} embedding for input ${JSON.stringify(body.input).slice(0, 160)}. Re-record with: npx tsx packages/search/scripts/record-fixtures.ts`,
        );
      }
      return { status: rec.status, headers: { 'content-type': 'application/json' }, body: rec.body };
    },
  };
}

export interface EvalQuery {
  id: string;
  type: 'exact' | 'paraphrase' | 'negation';
  query: string;
  expect: { videoId: string; startSec: number; endSec: number }[];
  evidence: string;
}

export function loadQueries(): EvalQuery[] {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/queries.json', import.meta.url), 'utf8')) as { queries: EvalQuery[] };
  return raw.queries;
}

/**
 * MemoryStorage plus the process-local VectorStore and KvStore from core, as
 * one backend: stands in for a persistent library (SQLite, D1, Postgres) that
 * implements the storage extensions, so the engine stores vectors and its
 * manifest in storage and a second engine over it reuses them.
 */
export class MemoryLibrary extends MemoryStorage implements VectorStore, KvStore {
  private readonly vec = new MemoryVectors();
  private readonly kv = new MemoryKv();
  upsertCalls = 0;

  upsertVectors(records: VectorRecord[]): Promise<void> {
    this.upsertCalls++;
    return this.vec.upsertVectors(records);
  }
  deleteVectors(filter: { videoId: string; model?: string }): Promise<void> {
    return this.vec.deleteVectors(filter);
  }
  queryVectors(query: VectorQuery): Promise<VectorHit[]> {
    return this.vec.queryVectors(query);
  }
  kvGet<T = unknown>(key: string): Promise<T | null> {
    return this.kv.kvGet<T>(key);
  }
  kvSet(key: string, value: unknown, opts?: { ttlSec?: number }): Promise<void> {
    return this.kv.kvSet(key, value, opts);
  }
  kvDelete(key: string): Promise<void> {
    return this.kv.kvDelete(key);
  }
  kvList(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<{ keys: string[]; cursor?: string }> {
    return this.kv.kvList(prefix, opts);
  }
}
