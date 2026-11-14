/**
 * Builds a VideoContext from recorded fixtures: a Deepgram nova-3 diarized
 * response (recorded through Cloudflare Workers AI) and the Wikimedia Commons
 * file record for the same clip. Shared by the unit tests and the recorder.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Segment, VideoContext } from '@vid2context/core';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

export interface Clip {
  /** Fixture file stem, e.g. 'nixon-armstrong-call'. */
  stem: string;
  /** Wikimedia Commons file title. */
  commonsTitle: string;
}

export const CLIPS = {
  call: {
    stem: 'nixon-armstrong-call',
    commonsTitle: 'File:President Nixon speaking with astronauts Armstrong and Aldrin on the Moon.webm',
  },
  smallStep: { stem: 'apollo11-small-step', commonsTitle: 'File:Armstrong Small Step.ogg' },
} satisfies Record<string, Clip>;

interface Nova3Response {
  result: {
    results: {
      utterances?: { start: number; end: number; transcript: string; speaker?: number; confidence?: number }[];
    };
  };
}

interface CommonsResponse {
  query: {
    pages: Record<
      string,
      { title: string; imageinfo: { descriptionurl: string; extmetadata: Record<string, { value: string }> }[] }
    >;
  };
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as T;
}

/** Deepgram utterances as segments labelled "Speaker N", the shape a diarizing rung returns. */
export function segmentsFromNova3(res: Nova3Response): Segment[] {
  return (res.result.results.utterances ?? []).map((u) => ({
    startSec: u.start,
    endSec: u.end,
    text: u.transcript.trim(),
    speaker: `Speaker ${u.speaker ?? 0}`,
    confidence: u.confidence,
  }));
}

export function loadContext(clip: Clip): VideoContext {
  const nova = readJson<Nova3Response>(`nova3-${clip.stem}.json`);
  const commons = readJson<CommonsResponse>(`commons-${clip.stem}.json`);
  const page = Object.values(commons.query.pages)[0];
  if (!page?.imageinfo[0]) throw new Error(`commons fixture for ${clip.stem} has no imageinfo`);
  const info = page.imageinfo[0];
  const meta = info.extmetadata;
  const nativeId = page.title.replace(/^File:/, '');
  const ref = {
    input: info.descriptionurl,
    platform: 'web',
    kind: 'video' as const,
    id: `web:${nativeId}`,
    nativeId,
    url: info.descriptionurl,
  };
  return {
    metadata: {
      ref,
      title: nativeId.replace(/\.[a-z0-9]+$/i, ''),
      channel: meta.Artist ? { name: stripHtml(meta.Artist.value) } : undefined,
      description: meta.ImageDescription ? stripHtml(meta.ImageDescription.value) : undefined,
      chapters: [],
    },
    transcript: {
      ref,
      language: 'en',
      origin: 'stt',
      producer: 'stt/cloudflare/@cf/deepgram/nova-3',
      model: 'nova-3',
      segments: segmentsFromNova3(nova),
      createdAt: '2026-11-14T17:05:00.000Z',
    },
    attempts: [],
  };
}
