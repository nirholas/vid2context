/**
 * Shared test setup: the real shared VideoContext fixtures, a registry with
 * the YouTube source and the OpenAI-compatible LLM rungs, and replay of
 * recorded LLM exchanges. Recorded calls are served in order, matched by URL
 * and the model named in the request body, so a fallback replays exactly as
 * it happened when recorded.
 */
import { readFileSync } from 'node:fs';
import { type Collection, MemoryStorage, Registry, type VideoContext } from '@vid2context/core';
import { type RecordedCall, type ReplayFetch, replayFetch } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import youtube from '@vid2context/provider-youtube';

export const GWAGON_URL = 'https://www.youtube.com/watch?v=cCPsdFdlshc';
export const ZOO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

export function loadContext(file: 'youtube-cCPsdFdlshc.json' | 'youtube-jNQXAC9IVRw.json'): VideoContext {
  return JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8')) as VideoContext;
}

export function makeRegistry(): Registry {
  return new Registry([...youtube, llm], 'node');
}

/** A MemoryStorage holding both shared contexts, and a collection with both. */
export async function makeStorage(): Promise<{ storage: MemoryStorage; collection: Collection }> {
  const storage = new MemoryStorage();
  await storage.putContext(loadContext('youtube-cCPsdFdlshc.json'));
  await storage.putContext(loadContext('youtube-jNQXAC9IVRw.json'));
  const created = await storage.createCollection({ name: 'G-Wagon and zoo' });
  const collection = await storage.addToCollection(created.id, ['youtube:cCPsdFdlshc', 'youtube:jNQXAC9IVRw']);
  return { storage, collection };
}

export interface RecordedExchange {
  url: string;
  /** The `model` field of the request body. */
  model: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Recording {
  scenario: string;
  recordedAt: string;
  notes: string;
  calls: RecordedExchange[];
}

export function loadRecording(name: string): Recording {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Recording;
}

export function modelOf(call: RecordedCall): string {
  try {
    return (JSON.parse(String(call.body)) as { model?: string }).model ?? '';
  } catch {
    return '';
  }
}

/** Replay a recording: each exchange is served once, in order, to a request with the same URL and model. */
export function replayRecording(rec: Recording): ReplayFetch {
  const left = [...rec.calls];
  return replayFetch([
    {
      url: (u) => left.some((c) => c.url === u.href),
      response: (call) => {
        const i = left.findIndex((c) => c.url === call.url && c.model === modelOf(call));
        if (i === -1) throw new Error(`replay: no recorded exchange left for ${call.url} model ${modelOf(call)}`);
        const [hit] = left.splice(i, 1);
        if (!hit) throw new Error('replay: exchange vanished');
        return { status: hit.status, headers: hit.headers, body: hit.body };
      },
    },
  ]);
}
