/**
 * Recorded LLM exchanges, shared by the recording script and the tests.
 *
 * A recording is every HTTP exchange one real run made, in order, with the
 * time it happened relative to the start. Replay serves them in the same
 * order (checking URL and model match) and moves the Date clock to each
 * exchange's offset, so the core chain's rung cooldowns (for example after a
 * recorded 429) expire exactly as they did live.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoContext } from '@vid2context/core';
import { type ReplayFetch, replayFetch } from '@vid2context/core/testing';
import { vi } from 'vitest';

export interface Exchange {
  atMs: number;
  url: string;
  method: string;
  /** The model named in the request body. */
  model?: string;
  status: number;
  contentType?: string;
  retryAfter?: string;
  body: string;
}

export interface Recording {
  scenario: string;
  recordedAt: string;
  note: string;
  exchanges: Exchange[];
}

const FIXTURES = join(import.meta.dirname, 'fixtures');

export function loadRecording(name: string): Recording {
  return JSON.parse(readFileSync(join(FIXTURES, 'llm', `${name}.json`), 'utf8')) as Recording;
}

/** Index 0 is the shared part-1 fixture; 1 to 3 are this package's G-Wagon series fixtures. */
export const GWAGON_IDS = ['cCPsdFdlshc', 'q6dzm-O1i2o', 'ovIkN7UgbgE', '1Xx1fmHIsiA'] as const;

export function gwagonContext(i: number): VideoContext {
  const id = GWAGON_IDS[i];
  const file =
    i === 0
      ? join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json')
      : join(FIXTURES, 'contexts', `youtube-${id}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as VideoContext;
}

export function gwagonContexts(): VideoContext[] {
  return GWAGON_IDS.map((_, i) => gwagonContext(i));
}

function modelOf(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    return (JSON.parse(body) as { model?: string }).model;
  } catch {
    return undefined;
  }
}

/**
 * A fetch that replays a recording in order. Call inside a test after
 * `vi.useFakeTimers({ toFake: ['Date'] })`; it sets the clock per exchange.
 */
export function replayRecording(rec: Recording, start = Date.UTC(2026, 10, 14, 12)): ReplayFetch & { remaining: () => number } {
  let i = 0;
  vi.setSystemTime(start);
  const fetch = replayFetch([
    {
      url: () => true,
      response: (call) => {
        const ex = rec.exchanges[i++];
        if (!ex) throw new Error(`recording ${rec.scenario}: no exchange left for ${call.method} ${call.url}`);
        const model = modelOf(call.body);
        if (ex.url !== call.url || (ex.model && ex.model !== model)) {
          throw new Error(
            `recording ${rec.scenario}: exchange ${i} was ${ex.url} (${ex.model}), the run asked ${call.url} (${model})`,
          );
        }
        vi.setSystemTime(start + ex.atMs);
        return {
          status: ex.status,
          headers: {
            ...(ex.contentType ? { 'content-type': ex.contentType } : {}),
            ...(ex.retryAfter ? { 'retry-after': ex.retryAfter } : {}),
          },
          body: ex.body,
        };
      },
    },
  ]);
  return Object.assign(fetch, { remaining: () => rec.exchanges.length - i });
}
