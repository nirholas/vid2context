/**
 * Recorded reference transcripts. A reference is a real caption track
 * downloaded once and stored as JSON, so scoring does not depend on YouTube
 * being reachable or the track staying unchanged.
 *
 * File name: `<platform>-<nativeId>.<origin>.<language>.json`, for example
 * `youtube-UNP03fDSj1U.creator-captions.en.json`. Committed references live
 * in packages/evals/datasets/refs/; references fetched during a run without
 * `--record` go to the cache (.vid2context/cache/evals/refs/).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Segment, Transcript, TranscriptOrigin } from '@vid2context/core';

export interface RecordedRef {
  videoId: string;
  url?: string;
  title?: string;
  language: string;
  origin: TranscriptOrigin;
  producer: string;
  /** ISO 8601 date the track was downloaded. */
  recordedAt: string;
  segments: Segment[];
}

export const REFS_DIR = fileURLToPath(new URL('../datasets/refs/', import.meta.url));

export function refFileName(videoId: string, origin: TranscriptOrigin, language: string): string {
  return `${videoId.replace(':', '-')}.${origin}.${language}.json`;
}

/** First match among the directories, in order. Language matches on the primary subtag when no exact file exists. */
export function findRef(
  dirs: readonly string[],
  videoId: string,
  origin: TranscriptOrigin,
  language: string,
): RecordedRef | null {
  const names = [refFileName(videoId, origin, language), refFileName(videoId, origin, language.split('-')[0] ?? language)];
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name);
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as RecordedRef;
    }
  }
  return null;
}

export function refFromTranscript(t: Transcript, title?: string): RecordedRef {
  return {
    videoId: t.ref.id,
    url: t.ref.url,
    title,
    language: t.language,
    origin: t.origin,
    producer: t.producer,
    recordedAt: t.createdAt.slice(0, 10),
    segments: t.segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text })),
  };
}

export function saveRef(dir: string, ref: RecordedRef): string {
  const path = join(dir, refFileName(ref.videoId, ref.origin, ref.language));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ref, null, 2)}\n`);
  return path;
}

/** Plain text of a reference or transcript, segments joined by spaces. */
export function textOf(segments: readonly Segment[]): string {
  return segments.map((s) => s.text).join(' ');
}
