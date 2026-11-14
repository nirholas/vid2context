/**
 * Per-account (or per-IP, for anonymous callers) daily usage and quota
 * enforcement. Counters live in the KvStore under the UTC day and reset at
 * 00:00 UTC.
 *
 * Speech-to-text minutes are counted where they are spent: UsageMeter wraps
 * the registry's speech-to-text, video and LLM rungs for one request, so a
 * result served from storage or the shared cache never reaches a rung and
 * costs nothing. Minutes come from the audio duration the pipeline hands the
 * rung (AudioInput.durationSec), or the transcript's last segment end when
 * the source did not report one.
 *
 * KV has no atomic increment, so two requests finishing at the same moment
 * can each read the old count: counters may undercount slightly under heavy
 * concurrency. That is acceptable for free-tier fairness limits.
 *
 * Keys:
 *   accounts:usage:<principal>:<YYYY-MM-DD>   UsageCounters (kept 2 days)
 */
import {
  type KvStore,
  type LlmRung,
  type Registry,
  type Segment,
  type SttRung,
  Vid2ContextError,
  type VideoRung,
} from '@vid2context/core';
import type { Plan } from './plans.ts';

export interface UsageCounters {
  requests: number;
  sttSeconds: number;
  llmCalls: number;
}

export type LimitName = 'requests' | 'stt' | 'llm';

export interface LimitHit {
  limit: LimitName;
  message: string;
  hint: string;
  retryAfterSec: number;
}

const ZERO: UsageCounters = { requests: 0, sttSeconds: 0, llmCalls: 0 };

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function secondsUntilUtcMidnight(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

function lastEnd(segments: Segment[] | undefined): number {
  let end = 0;
  for (const s of segments ?? []) if (s.endSec > end) end = s.endSec;
  return end;
}

function wait(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.ceil((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** A rate-limited error for a hit, for surfaces that throw instead of answering directly. */
export function limitError(hit: LimitHit): Vid2ContextError {
  return new Vid2ContextError('rate-limited', hit.message, { hint: hit.hint, retryAfterSec: hit.retryAfterSec, status: 429 });
}

export class UsageMeter {
  /** Set when a metered rung refused to run because a limit was reached during this request. */
  blocked?: LimitHit;
  private readonly key: string;

  constructor(
    private readonly kv: KvStore,
    /** Account id, or `ip_<hash>` for anonymous callers. */
    readonly principal: string,
    readonly planName: string,
    readonly plan: Plan,
    private readonly now: () => number = Date.now,
  ) {
    this.key = `accounts:usage:${principal}:${utcDay(this.now())}`;
  }

  get period(): string {
    return utcDay(this.now());
  }

  async read(): Promise<UsageCounters> {
    return { ...ZERO, ...((await this.kv.kvGet<UsageCounters>(this.key)) ?? {}) };
  }

  async add(delta: Partial<UsageCounters>): Promise<UsageCounters> {
    const cur = await this.read();
    const next: UsageCounters = {
      requests: cur.requests + (delta.requests ?? 0),
      sttSeconds: cur.sttSeconds + (delta.sttSeconds ?? 0),
      llmCalls: cur.llmCalls + (delta.llmCalls ?? 0),
    };
    await this.kv.kvSet(this.key, next, { ttlSec: 2 * 86_400 });
    return next;
  }

  hit(limit: LimitName, detail?: string): LimitHit {
    const retryAfterSec = secondsUntilUtcMidnight(this.now());
    const p = this.plan;
    const what =
      limit === 'requests'
        ? `the daily request limit (${p.requestsPerDay} requests per day)`
        : limit === 'stt'
          ? `the daily speech-to-text limit (${p.sttMinutesPerDay} audio minutes per day)`
          : `the daily LLM limit (${p.llmCallsPerDay} LLM calls per day)`;
    const extra =
      limit === 'stt'
        ? ' Videos with captions still work: retry with mode=captions, or use a video another user already transcribed.'
        : '';
    return {
      limit,
      message: `This request would exceed ${what} of the ${this.planName} plan.${detail ? ` ${detail}` : ''}`,
      hint: `The limit resets at 00:00 UTC, in ${wait(retryAfterSec)}.${extra}`,
      retryAfterSec,
    };
  }

  /** Count one request. Returns the hit (and counts nothing) when the daily request limit is used up. */
  async chargeRequest(): Promise<LimitHit | null> {
    const cur = await this.read();
    if (cur.requests >= this.plan.requestsPerDay) return this.hit('requests');
    await this.add({ requests: 1 });
    return null;
  }

  async sttSecondsLeft(): Promise<number> {
    return Math.max(0, this.plan.sttMinutesPerDay * 60 - (await this.read()).sttSeconds);
  }

  async llmCallsLeft(): Promise<number> {
    return Math.max(0, this.plan.llmCallsPerDay - (await this.read()).llmCalls);
  }

  /** Refuse inside a rung: remember the hit for the response and stop the chain without a rung cooldown. */
  private refuse(limit: LimitName, detail?: string): never {
    const hit = this.hit(limit, detail);
    this.blocked = hit;
    // bad-request is an input error: runChain stops at once and puts no cooldown on the shared rung.
    throw new Vid2ContextError('bad-request', hit.message, { hint: hit.hint });
  }

  private sttRung(rung: SttRung): SttRung {
    const w = Object.create(rung) as SttRung;
    w.transcribe = async (audio, opts, ctx) => {
      const left = await this.sttSecondsLeft();
      if (left <= 0) this.refuse('stt');
      if (audio.durationSec !== undefined && audio.durationSec > left) {
        this.refuse(
          'stt',
          `This audio is ${Math.ceil(audio.durationSec / 60)} min; ${Math.floor(left / 60)} min are left today.`,
        );
      }
      const res = await rung.transcribe(audio, opts, ctx);
      await this.add({ sttSeconds: Math.ceil(audio.durationSec ?? lastEnd(res.segments)) });
      return res;
    };
    return w;
  }

  private videoRung(rung: VideoRung): VideoRung {
    const w = Object.create(rung) as VideoRung;
    w.understand = async (ref, opts, ctx) => {
      if ((await this.sttSecondsLeft()) <= 0) this.refuse('stt');
      const res = await rung.understand(ref, opts, ctx);
      const sec = Math.ceil(lastEnd(res.transcript?.segments));
      if (sec > 0) await this.add({ sttSeconds: sec });
      return res;
    };
    return w;
  }

  private llmRung(rung: LlmRung): LlmRung {
    const w = Object.create(rung) as LlmRung & { stream?: (...args: unknown[]) => AsyncIterable<unknown> };
    w.chat = async (req, ctx) => {
      if ((await this.llmCallsLeft()) <= 0) this.refuse('llm');
      const res = await rung.chat(req, ctx);
      await this.add({ llmCalls: 1 });
      return res;
    };
    const inner = (rung as { stream?: (...args: unknown[]) => AsyncIterable<unknown> }).stream;
    if (typeof inner === 'function') {
      const meter = this;
      w.stream = async function* (...args: unknown[]) {
        if ((await meter.llmCallsLeft()) <= 0) meter.refuse('llm');
        yield* inner.apply(rung, args);
        await meter.add({ llmCalls: 1 });
      };
    }
    return w;
  }

  /**
   * A view of `registry` for one request whose speech-to-text, video and LLM
   * rungs count usage against this meter. Everything else (sources, captions,
   * storage, health) is the original registry, through the prototype.
   */
  wrapRegistry(registry: Registry): Registry {
    const r = Object.create(registry) as Registry;
    r.sttRungs = (env) => registry.sttRungs(env).map((x) => this.sttRung(x));
    r.videoRungs = (env) => registry.videoRungs(env).map((x) => this.videoRung(x));
    r.llmRungs = (env) => registry.llmRungs(env).map((x) => this.llmRung(x));
    return r;
  }
}
