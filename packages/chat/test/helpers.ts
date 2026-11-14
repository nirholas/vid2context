/**
 * Fixture loading for the chat tests. Every file is a real recording; see
 * test/fixtures/README.md for where and when each was made.
 */
import { readFileSync } from 'node:fs';
import type { VideoContext } from '@vid2context/core';
import type { RecordedResponse, Route } from '@vid2context/core/testing';
import type { ChatApiRequest, ChatEvent, ModelInfo } from '../src/lib/types.ts';

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

export function fixtureJson<T>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

/** Shared real VideoContext output in tests/fixtures/contexts/. */
export function sharedContext(id: 'cCPsdFdlshc' | 'jNQXAC9IVRw'): VideoContext {
  return JSON.parse(
    readFileSync(new URL(`../../../tests/fixtures/contexts/youtube-${id}.json`, import.meta.url), 'utf8'),
  ) as VideoContext;
}

export function sharedContextText(id: 'cCPsdFdlshc' | 'jNQXAC9IVRw'): string {
  return readFileSync(new URL(`../../../tests/fixtures/contexts/youtube-${id}.json`, import.meta.url), 'utf8');
}

export interface ClientRecording {
  recordedAt: string;
  case: string;
  env: string[];
  request: ChatApiRequest;
  responses: { url: string; method: string; status: number; headers: Record<string, string>; body: string }[];
  events: ChatEvent[];
}

export function clientRecording(name: 'ovh-gpt-oss' | 'groq-bad-key'): ClientRecording {
  return fixtureJson<ClientRecording>(`client-${name}.json`);
}

/** replayFetch routes that answer each recorded upstream URL with its recorded response. */
export function routesFor(rec: ClientRecording): Route[] {
  return rec.responses.map((r) => ({
    method: r.method,
    url: r.url,
    response: { status: r.status, headers: r.headers, body: r.body } satisfies RecordedResponse,
  }));
}

export function serverModels(): ModelInfo[] {
  return fixtureJson<{ models: ModelInfo[] }>('server-models.json').models;
}

export function browserModels(which: 'nokeys' | 'groq'): ModelInfo[] {
  return fixtureJson<{ models: ModelInfo[] }>(`models-browser-${which}.json`).models;
}

/** A ReadableStream over `text`, cut into chunks of `size` bytes, to exercise boundary handling. */
export function chunkedStream(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}
