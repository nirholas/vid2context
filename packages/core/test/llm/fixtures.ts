import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordedResponse } from '../../src/testing.ts';

// Real recordings, 2026-11-14 (see test/fixtures/llm/README.md).
const dir = join(import.meta.dirname, '..', 'fixtures', 'llm');

export interface Recording {
  url: string;
  status: number;
  headers: Record<string, string>;
  request: Record<string, unknown>;
  body: Uint8Array;
}

export function recording(name: string): Recording {
  const meta = JSON.parse(readFileSync(join(dir, `${name}.meta.json`), 'utf8')) as Omit<Recording, 'body'>;
  return { ...meta, body: new Uint8Array(readFileSync(join(dir, `${name}.body`))) };
}

export function response(rec: Recording, body: Uint8Array = rec.body): RecordedResponse {
  return { status: rec.status, headers: rec.headers, body };
}

/** A byte stream that delivers `bytes` in the given chunks. */
export function chunked(bytes: Uint8Array, cuts: number[]): ReadableStream<Uint8Array> {
  const points = [0, ...cuts.filter((c) => c > 0 && c < bytes.length).sort((a, b) => a - b), bytes.length];
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= points.length - 1) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(points[i], points[i + 1]));
      i++;
    },
  });
}

/** What the recorded stream says independently of the code under test: content and reasoning joined, and the usage chunk. */
export function expected(rec: Recording): {
  content: string;
  reasoning: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
} {
  let content = '';
  let reasoning = '';
  let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
  for (const line of new TextDecoder().decode(rec.body).split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const chunk = JSON.parse(line.slice(6));
    if (chunk.usage) usage = chunk.usage;
    const d = chunk.choices?.[0]?.delta ?? {};
    if (d.content) content += d.content;
    if (d.reasoning) reasoning += d.reasoning;
  }
  return { content, reasoning, usage };
}

export const STREAMS = [
  'ovh-gpt-oss-120b.stream',
  'ovh-llama-3.3-70b.stream',
  'pollinations-openai-fast.stream',
  'pollinations-openai-fast.japanese.stream',
];
