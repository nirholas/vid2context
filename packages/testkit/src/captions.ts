/**
 * Conformance suite for captions providers: supports() agrees with the
 * source's refs, getCaptions() returns ordered, well-formed transcripts from
 * recorded responses, and returns null (not an error) when a video has no
 * tracks.
 */
import type { CaptionOptions, CaptionsProvider, Env, SourceProvider, Transcript, VideoRef } from '@vid2context/core';
import { type Route, replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { BCP47, isPromiseLike, withoutNetwork, withoutNetworkAsync } from './fixtures.ts';

export const CAPTION_ORIGINS = ['creator-captions', 'auto-captions', 'native-transcript'] as const;

export interface CaptionCase {
  /** Input resolved through `source.match`, or give `ref` directly. */
  input?: string;
  ref?: VideoRef;
  routes: Route[];
  options?: CaptionOptions;
  env?: Env;
  /** 'transcript' when the recorded video has a usable track; 'none' when getCaptions must return null. */
  expect: 'transcript' | 'none';
  language?: string;
  origin?: (typeof CAPTION_ORIGINS)[number];
  /** Pinned segment count. */
  segments?: number;
}

export interface CaptionCases {
  /** The source whose refs this provider serves. */
  source?: SourceProvider;
  cases: CaptionCase[];
  /** Inputs (resolved through `source`) or refs this provider must not claim. */
  unsupported?: (string | VideoRef)[];
  /** Allowed overlap between consecutive segments, in seconds. Default 0.5. */
  overlapToleranceSec?: number;
}

/** Problems with a transcript returned by a captions provider (empty when well-formed). */
export function transcriptProblems(t: Transcript, ref: VideoRef, toleranceSec = 0.5): string[] {
  const p: string[] = [];
  if (t.ref?.id !== ref.id) p.push(`transcript.ref.id "${t.ref?.id}" differs from "${ref.id}"`);
  if (!BCP47.test(t.language ?? '')) p.push(`language "${t.language}" is not BCP-47`);
  if (!(CAPTION_ORIGINS as readonly string[]).includes(t.origin)) p.push(`origin "${t.origin}" is not a captions origin`);
  if (!t.producer) p.push('producer is empty');
  if (Number.isNaN(Date.parse(t.createdAt))) p.push(`createdAt "${t.createdAt}" is not ISO 8601`);
  if (!Array.isArray(t.segments) || t.segments.length === 0) {
    p.push('segments is empty; return null when there is no usable track');
    return p;
  }
  for (let i = 0; i < t.segments.length; i++) {
    const s = t.segments[i];
    if (!s) continue;
    if (!Number.isFinite(s.startSec) || !Number.isFinite(s.endSec) || s.startSec < 0 || s.endSec < s.startSec) {
      p.push(`segment ${i} has bad timing ${s.startSec}..${s.endSec}`);
    }
    if (typeof s.text !== 'string' || s.text.trim() === '') p.push(`segment ${i} has empty text`);
    const prev = t.segments[i - 1];
    if (prev) {
      if (s.startSec < prev.startSec) p.push(`segment ${i} starts before segment ${i - 1}`);
      else if (s.startSec < prev.endSec - toleranceSec) {
        p.push(`segment ${i} overlaps segment ${i - 1} by ${(prev.endSec - s.startSec).toFixed(2)}s`);
      }
    }
    if (p.length > 20) {
      p.push('more problems not listed');
      break;
    }
  }
  return p;
}

function refFor(c: { input?: string; ref?: VideoRef }, source: SourceProvider | undefined): VideoRef {
  if (c.ref) return c.ref;
  if (!c.input || !source) throw new Error('captions case needs `ref`, or `input` plus a `source`');
  const ref = source.match(c.input);
  if (!ref) throw new Error(`source ${source.id} did not match ${c.input}`);
  return ref;
}

export function describeCaptions(provider: CaptionsProvider, cases: CaptionCases): void {
  describe(`captions conformance: ${provider.id}`, () => {
    it('declares kind captions and a kebab-case id', () => {
      expect(provider.kind).toBe('captions');
      expect(provider.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    it("supports() is synchronous, offline and agrees with the source's refs", () => {
      for (const c of cases.cases) {
        const ref = refFor(c, cases.source);
        const { value, touched } = withoutNetwork(() => provider.supports(ref));
        expect(touched).toEqual([]);
        expect(isPromiseLike(value)).toBe(false);
        expect(value, `supports() is false for ${ref.id}`).toBe(true);
      }
      for (const u of cases.unsupported ?? []) {
        const ref = typeof u === 'string' ? refFor({ input: u }, cases.source) : u;
        expect(withoutNetwork(() => provider.supports(ref)).value, `supports() claims ${ref.id}`).toBe(false);
      }
    });

    for (const c of cases.cases) {
      const label = c.ref?.id ?? c.input ?? 'case';
      const opts = c.options ? ` ${JSON.stringify(c.options)}` : '';
      if (c.expect === 'none') {
        it(`getCaptions() returns null (not an error) when ${label} has no tracks`, async () => {
          const ref = refFor(c, cases.source);
          const ctx = testContext({ env: c.env ?? {}, fetch: replayFetch(c.routes) });
          await expect(provider.getCaptions(ref, c.options ?? {}, ctx)).resolves.toBeNull();
        });
        continue;
      }
      it(`getCaptions() returns an ordered, well-formed transcript for ${label}${opts}`, async () => {
        const ref = refFor(c, cases.source);
        const ctx = testContext({ env: c.env ?? {}, fetch: replayFetch(c.routes) });
        const { value: t, touched } = await withoutNetworkAsync(() => provider.getCaptions(ref, c.options ?? {}, ctx));
        expect(touched, 'getCaptions used the global fetch instead of ctx.fetch').toEqual([]);
        expect(t, 'getCaptions returned null for a video with captions').not.toBeNull();
        if (!t) return;
        expect(transcriptProblems(t, ref, cases.overlapToleranceSec)).toEqual([]);
        if (c.language) expect(t.language).toBe(c.language);
        if (c.origin) expect(t.origin).toBe(c.origin);
        if (c.segments !== undefined) expect(t.segments).toHaveLength(c.segments);
      });
    }
  });
}
