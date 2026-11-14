/**
 * Conformance suites for speech-to-text, LLM and embedding rungs. Each one
 * declares vitest blocks: static checks on the rung, then calls replayed from
 * recorded responses, then recorded error responses.
 */
import {
  type AudioInput,
  type ChatRequest,
  type EmbedRung,
  type Env,
  type ErrorCode,
  type LlmRung,
  type Rung,
  type SttOptions,
  type SttRung,
  Vid2ContextError,
} from '@vid2context/core';
import { type RecordedCall, type Route, replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { BCP47, withoutNetworkAsync } from './fixtures.ts';
import { expectedCodeForStatus, type RungKind, rungProblems } from './rung-checks.ts';

export const ERROR_CODES: ErrorCode[] = [
  'unsupported-input',
  'not-found',
  'unavailable',
  'no-transcript',
  'no-provider',
  'all-rungs-failed',
  'rate-limited',
  'auth',
  'blocked',
  'too-large',
  'timeout',
  'upstream',
  'bad-request',
];

/** A recorded failure: the routes answer with a real 4xx/5xx response. */
export interface RecordedErrorCase {
  name?: string;
  routes: Route[];
  /** HTTP status of the recorded response; the expected code follows errorFromResponse unless `code` is given. */
  status?: number;
  code?: ErrorCode | ErrorCode[];
}

interface RecordedBase {
  /** Env for the call ctx (the rung's own key, when it needs one). Never process.env. */
  env?: Env;
  routes: Route[];
  errors?: RecordedErrorCase[];
}

export interface SttRecorded extends RecordedBase {
  audio: AudioInput;
  options?: SttOptions;
  /** Text the transcript must contain (case-insensitive) or match. */
  expectText?: string | RegExp;
}

export interface LlmRecorded extends RecordedBase {
  request: ChatRequest;
  expectText?: string | RegExp;
}

export interface EmbedRecorded extends RecordedBase {
  texts: string[];
}

type TestCtx = ReturnType<typeof testContext>;

function staticBlock(kind: RungKind, rung: Rung): void {
  it('follows the rung contract (id, tier, requires, quality, env-only isEnabled)', () => {
    expect(rungProblems(rung, kind)).toEqual([]);
  });
}

function keylessHeaderCheck(rung: Rung, calls: RecordedCall[]): void {
  if (rung.tier !== 'keyless') return;
  for (const c of calls) expect(c.headers.authorization, `keyless rung sent Authorization to ${c.url}`).toBeUndefined();
}

async function runCall<T>(routes: Route[], env: Env | undefined, call: (ctx: TestCtx) => Promise<T>) {
  const fetch = replayFetch(routes);
  const ctx = testContext({ env: env ?? {}, fetch });
  const { value, touched } = await withoutNetworkAsync(() => call(ctx));
  expect(touched, 'the rung used the global fetch instead of ctx.fetch').toEqual([]);
  return { value, calls: fetch.calls };
}

function errorBlock(errors: RecordedErrorCase[] | undefined, env: Env | undefined, call: (ctx: TestCtx) => Promise<unknown>) {
  for (const [i, e] of (errors ?? []).entries()) {
    it(`maps a recorded error to Vid2ContextError: ${e.name ?? (e.status ? `HTTP ${e.status}` : `case ${i + 1}`)}`, async () => {
      const fetch = replayFetch(e.routes);
      const err = await call(testContext({ env: env ?? {}, fetch })).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(err, 'the call resolved; a recorded error response must reject').toBeDefined();
      expect(err).toBeInstanceOf(Vid2ContextError);
      const v = err as Vid2ContextError;
      expect(ERROR_CODES).toContain(v.code);
      const want = e.code ?? (e.status === undefined ? undefined : expectedCodeForStatus(e.status));
      if (want !== undefined) expect(Array.isArray(want) ? want : [want]).toContain(v.code);
      if (e.status !== undefined && v.status !== undefined) expect(v.status).toBe(e.status);
    });
  }
}

function matchText(text: string, want: string | RegExp | undefined): void {
  if (want === undefined) return;
  if (typeof want === 'string') expect(text.toLowerCase()).toContain(want.toLowerCase());
  else expect(text).toMatch(want);
}

/** Conformance for one speech-to-text rung. */
export function describeSttRung(rung: SttRung, recorded: SttRecorded): void {
  describe(`stt rung conformance: ${rung.id}`, () => {
    staticBlock('stt', rung);

    it('transcribes recorded audio into timed, ordered segments', async () => {
      const { value: res, calls } = await runCall(recorded.routes, recorded.env, (ctx) =>
        rung.transcribe(recorded.audio, recorded.options ?? {}, ctx),
      );
      expect(typeof res.model).toBe('string');
      expect(res.model.length).toBeGreaterThan(0);
      expect(res.language).toMatch(BCP47);
      expect(res.segments.length).toBeGreaterThan(0);
      let prev = Number.NEGATIVE_INFINITY;
      for (const s of res.segments) {
        expect(Number.isFinite(s.startSec) && Number.isFinite(s.endSec)).toBe(true);
        expect(s.startSec).toBeGreaterThanOrEqual(0);
        expect(s.endSec).toBeGreaterThanOrEqual(s.startSec);
        expect(s.startSec).toBeGreaterThanOrEqual(prev);
        expect(typeof s.text).toBe('string');
        prev = s.startSec;
      }
      const all = res.segments.map((s) => s.text).join(' ');
      expect(all.trim().length).toBeGreaterThan(0);
      matchText(all, recorded.expectText);
      keylessHeaderCheck(rung, calls);
    });

    errorBlock(recorded.errors, recorded.env, (ctx) => rung.transcribe(recorded.audio, recorded.options ?? {}, ctx));
  });
}

/** Conformance for one LLM rung. */
export function describeLlmRung(rung: LlmRung, recorded: LlmRecorded): void {
  describe(`llm rung conformance: ${rung.id}`, () => {
    staticBlock('llm', rung);

    it('answers a recorded chat request with non-empty text', async () => {
      const { value: res, calls } = await runCall(recorded.routes, recorded.env, (ctx) => rung.chat(recorded.request, ctx));
      expect(typeof res.text).toBe('string');
      expect(res.text.trim().length).toBeGreaterThan(0);
      expect(typeof res.model).toBe('string');
      expect(res.model.length).toBeGreaterThan(0);
      for (const n of [res.usage?.inputTokens, res.usage?.outputTokens]) {
        if (n !== undefined) expect(Number.isFinite(n) && n >= 0).toBe(true);
      }
      if (recorded.request.json) expect(() => JSON.parse(res.text)).not.toThrow();
      matchText(res.text, recorded.expectText);
      keylessHeaderCheck(rung, calls);
    });

    errorBlock(recorded.errors, recorded.env, (ctx) => rung.chat(recorded.request, ctx));
  });
}

/** Conformance for one embedding rung. */
export function describeEmbedRung(rung: EmbedRung, recorded: EmbedRecorded): void {
  describe(`embed rung conformance: ${rung.id}`, () => {
    staticBlock('embed', rung);

    it('returns one finite vector of `dimensions` length per input text', async () => {
      const { value: vectors, calls } = await runCall(recorded.routes, recorded.env, (ctx) => rung.embed(recorded.texts, ctx));
      expect(vectors).toHaveLength(recorded.texts.length);
      for (const v of vectors) {
        expect(v).toHaveLength(rung.dimensions);
        expect(v.every((x) => typeof x === 'number' && Number.isFinite(x))).toBe(true);
      }
      keylessHeaderCheck(rung, calls);
    });

    errorBlock(recorded.errors, recorded.env, (ctx) => rung.embed(recorded.texts, ctx));
  });
}
