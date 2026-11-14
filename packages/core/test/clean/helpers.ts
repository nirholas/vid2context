import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Segment, Transcript, VideoContext } from '../../src/index.ts';

export const ROOT = join(import.meta.dirname, '../../../..');
export const CLEAN_FIXTURES = join(import.meta.dirname, '../fixtures/clean');

export function context(name: string): VideoContext {
  return JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/contexts', name), 'utf8')) as VideoContext;
}

export function fixture(name: string): string {
  return readFileSync(join(CLEAN_FIXTURES, name), 'utf8');
}

/** Segments from a recorded OpenAI-compatible verbose_json response, mapped the way the STT provider maps them. */
export function verboseSegments(name: string): Segment[] {
  const json = JSON.parse(fixture(name)) as { segments: { start: number; end: number; text: string }[] };
  return json.segments.map((s) => ({ startSec: s.start, endSec: s.end, text: s.text.trim() }));
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Lowercased words with punctuation stripped, in order. */
export function bareWords(segments: readonly Segment[]): string[] {
  return segments
    .flatMap((s) => s.text.split(/\s+/))
    .map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
}

export function sttTranscript(segments: Segment[]): Transcript {
  return {
    ref: { input: 'apollo.mp3', platform: 'file', kind: 'video', id: 'file:apollo', nativeId: 'apollo' },
    language: 'en',
    origin: 'stt',
    producer: 'stt/ovh/whisper-large-v3-turbo',
    segments,
    createdAt: '2026-11-14T00:00:00.000Z',
  };
}
