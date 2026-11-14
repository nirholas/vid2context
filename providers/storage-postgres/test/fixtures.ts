import { readFileSync } from 'node:fs';
import type { VideoContext } from '@vid2context/core';

export function loadContext(file: 'youtube-cCPsdFdlshc.json' | 'youtube-jNQXAC9IVRw.json'): VideoContext {
  return JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8')) as VideoContext;
}

export interface EmbeddingFixture {
  recordedAt: string;
  url: string;
  request: { model: string; input: string[] };
  chunks: { videoId: string; idx: number; startSec: number; endSec: number; text: string }[];
  queries: string[];
  response: { model: string; data: { index: number; embedding: number[] }[] };
}

export function loadEmbeddings(): EmbeddingFixture {
  return JSON.parse(readFileSync(new URL('./fixtures/ovh-bge-m3-embeddings.json', import.meta.url), 'utf8')) as EmbeddingFixture;
}
