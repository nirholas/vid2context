/**
 * Conformance suite for source providers: match() is synchronous, offline and
 * builds well-formed refs; getMetadata() returns the required fields from
 * recorded responses.
 */
import type { Env, ErrorCode, RefKind, SourceProvider, VideoMetadata, VideoRef } from '@vid2context/core';
import { Vid2ContextError } from '@vid2context/core';
import { type Route, replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { BCP47, isPromiseLike, withoutNetwork, withoutNetworkAsync } from './fixtures.ts';

export const REF_KINDS: RefKind[] = ['video', 'playlist', 'channel', 'feed', 'page'];

export interface MatchCase {
  input: string;
  /** Expected ref id, when the caller wants it pinned. */
  id?: string;
  kind?: RefKind;
}

export interface MetadataCase {
  input: string;
  routes: Route[];
  env?: Env;
  /** Title the metadata must have (exact string or pattern). */
  title?: string | RegExp;
  /** Exact chapter count, when pinned. */
  chapters?: number;
}

export interface SourceErrorCase {
  input: string;
  routes: Route[];
  env?: Env;
  code: ErrorCode | ErrorCode[];
}

export interface SourceCases {
  matches: (string | MatchCase)[];
  rejects: string[];
  metadataCases?: MetadataCase[];
  /** Recorded responses for videos that cannot be had (removed, private): getMetadata must throw these codes. */
  metadataErrors?: SourceErrorCase[];
}

/** Problems with a ref, per docs/contracts/providers.md (empty when well-formed). */
export function refProblems(ref: VideoRef, input: string): string[] {
  const p: string[] = [];
  if (!ref.platform || !/^[a-z0-9][a-z0-9-]*$/.test(ref.platform))
    p.push(`platform "${ref.platform}" is not a short lowercase slug`);
  if (!REF_KINDS.includes(ref.kind)) p.push(`kind "${ref.kind}" is not one of ${REF_KINDS.join(', ')}`);
  if (!ref.nativeId) p.push('nativeId is empty');
  const want = ref.kind === 'video' ? `${ref.platform}:${ref.nativeId}` : `${ref.platform}:${ref.kind}:${ref.nativeId}`;
  // Single videos use platform:nativeId; lists use platform:kind:nativeId.
  if (ref.id !== want) p.push(`id "${ref.id}" should be "${want}"`);
  if (ref.input !== input && ref.input !== input.trim()) p.push(`input "${ref.input}" is not the raw input "${input}"`);
  if (ref.url !== undefined) {
    try {
      new URL(ref.url);
    } catch {
      p.push(`url "${ref.url}" is not an absolute URL`);
    }
  }
  return p;
}

/** Problems with metadata for a ref (empty when the required fields are present and sane). */
export function metadataProblems(meta: VideoMetadata, ref: VideoRef): string[] {
  const p: string[] = [];
  if (meta.ref?.id !== ref.id) p.push(`metadata.ref.id "${meta.ref?.id}" differs from the requested ref "${ref.id}"`);
  if (typeof meta.title !== 'string' || meta.title.trim() === '') p.push('title is empty');
  if (!Array.isArray(meta.chapters)) p.push('chapters is not an array');
  else {
    for (let i = 0; i < meta.chapters.length; i++) {
      const c = meta.chapters[i];
      if (!c || typeof c.title !== 'string' || !Number.isFinite(c.startSec) || c.startSec < 0)
        p.push(`chapter ${i} is malformed`);
      const prev = meta.chapters[i - 1];
      if (c && prev && c.startSec < prev.startSec) p.push(`chapter ${i} starts before chapter ${i - 1}`);
    }
  }
  if (meta.durationSec !== undefined && !(Number.isFinite(meta.durationSec) && meta.durationSec >= 0))
    p.push('durationSec is not a non-negative number');
  if (meta.publishedAt !== undefined && Number.isNaN(Date.parse(meta.publishedAt)))
    p.push(`publishedAt "${meta.publishedAt}" is not ISO 8601`);
  if (meta.language !== undefined && !BCP47.test(meta.language)) p.push(`language "${meta.language}" is not BCP-47`);
  return p;
}

export function describeSource(provider: SourceProvider, cases: SourceCases): void {
  describe(`source conformance: ${provider.id}`, () => {
    it('declares kind source, a kebab-case id and runtimes', () => {
      expect(provider.kind).toBe('source');
      expect(provider.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(provider.runtimes.length).toBeGreaterThan(0);
    });

    for (const m of cases.matches) {
      const c = typeof m === 'string' ? { input: m } : m;
      it(`match() accepts ${c.input} synchronously and offline`, () => {
        const { value: ref, touched } = withoutNetwork(() => provider.match(c.input));
        expect(touched, 'match() reached for the network').toEqual([]);
        expect(isPromiseLike(ref), 'match() returned a Promise; it must be synchronous').toBe(false);
        expect(ref, `match() returned null for ${c.input}`).not.toBeNull();
        if (!ref) return;
        expect(refProblems(ref, c.input)).toEqual([]);
        if (c.id) expect(ref.id).toBe(c.id);
        if (c.kind) expect(ref.kind).toBe(c.kind);
      });
    }

    if (cases.rejects.length > 0) {
      it('match() returns null for inputs it does not understand', () => {
        for (const input of cases.rejects) {
          const { value, touched } = withoutNetwork(() => provider.match(input));
          expect(touched).toEqual([]);
          expect(isPromiseLike(value)).toBe(false);
          expect(value, `match() accepted ${input}`).toBeNull();
        }
      });
    }

    for (const mc of cases.metadataCases ?? []) {
      it(`getMetadata() returns required fields for ${mc.input}`, async () => {
        const ref = provider.match(mc.input);
        expect(ref).not.toBeNull();
        if (!ref) return;
        const fetch = replayFetch(mc.routes);
        const ctx = testContext({ env: mc.env ?? {}, fetch });
        const { value: meta, touched } = await withoutNetworkAsync(() => provider.getMetadata(ref, ctx));
        expect(touched, 'getMetadata used the global fetch instead of ctx.fetch').toEqual([]);
        expect(metadataProblems(meta, ref)).toEqual([]);
        if (typeof mc.title === 'string') expect(meta.title).toBe(mc.title);
        else if (mc.title) expect(meta.title).toMatch(mc.title);
        if (mc.chapters !== undefined) expect(meta.chapters).toHaveLength(mc.chapters);
      });
    }

    for (const ec of cases.metadataErrors ?? []) {
      it(`getMetadata() throws a Vid2ContextError for ${ec.input}`, async () => {
        const ref = provider.match(ec.input);
        expect(ref).not.toBeNull();
        if (!ref) return;
        const ctx = testContext({ env: ec.env ?? {}, fetch: replayFetch(ec.routes) });
        const err = await provider.getMetadata(ref, ctx).then(
          () => undefined,
          (x: unknown) => x,
        );
        expect(err).toBeInstanceOf(Vid2ContextError);
        const codes = Array.isArray(ec.code) ? ec.code : [ec.code];
        expect(codes).toContain((err as Vid2ContextError).code);
        expect((err as Vid2ContextError).hint, 'user-visible errors need a hint').toBeTruthy();
      });
    }
  });
}
