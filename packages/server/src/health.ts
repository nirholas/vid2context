/**
 * Health for container probes and load balancers.
 *
 *   GET /healthz           liveness: 200 {"ok": true} without touching anything
 *   GET /healthz?deep=1    readiness: storage round trip, enabled STT and LLM
 *                          rungs, plus what the runtime adds (Node: disk space,
 *                          yt-dlp, ffmpeg, the keyless network; src/health-node.ts)
 *
 * Also served at /api/v1/healthz. A deep result is 503 when a required check
 * fails (storage, rungs and disk by default; VID2CONTEXT_HEALTH_REQUIRE adds
 * more, e.g. "yt-dlp,ffmpeg") and 200 with status "degraded" when only an
 * optional one does. Results are cached for VID2CONTEXT_HEALTH_CACHE_SEC
 * (default 15) and computed once for concurrent probes, so a probe flood
 * cannot turn into a process or network flood. Every check has a deadline
 * (VID2CONTEXT_HEALTH_TIMEOUT_MS, default 5000). Details name versions and
 * sizes, never file paths or key values.
 */
import { type Ctx, type Env, hasKv, type Registry, rankRungs, type Storage } from '@vid2context/core';

export type HealthStatus = 'ok' | 'warn' | 'fail';

export interface HealthCheck {
  id: string;
  status: HealthStatus;
  detail: string;
}

export interface DeepHealth {
  ok: boolean;
  status: 'ok' | 'degraded' | 'fail';
  checkedAt: string;
  checks: (HealthCheck & { required: boolean })[];
}

/** Extra checks a runtime adds (the Node entry passes nodeHealthChecks). */
export type HealthChecks = (ctx: Ctx) => Promise<HealthCheck[]>;

const DEFAULT_REQUIRED = ['storage', 'rungs', 'disk'];

function int(raw: string | undefined, fallback: number): number {
  const v = raw?.trim();
  const n = Number(v);
  return v && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function healthSettings(env: Env): { cacheMs: number; timeoutMs: number; required: Set<string> } {
  const extra = (env.VID2CONTEXT_HEALTH_REQUIRE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    cacheMs: int(env.VID2CONTEXT_HEALTH_CACHE_SEC, 15) * 1000,
    timeoutMs: int(env.VID2CONTEXT_HEALTH_TIMEOUT_MS, 5000) || 5000,
    required: new Set([...DEFAULT_REQUIRED, ...extra]),
  };
}

/** Settle with the check, or a failed check after `ms`. */
export async function withDeadline(id: string, ms: number, work: () => Promise<HealthCheck>): Promise<HealthCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<HealthCheck>((resolve) => {
    timer = setTimeout(() => resolve({ id, status: 'fail', detail: `no answer within ${ms} ms` }), ms);
  });
  try {
    return await Promise.race([
      work().catch((err: unknown) => ({ id, status: 'fail' as const, detail: err instanceof Error ? err.message : String(err) })),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Write, read back and delete a probe key, or report the backend when it has no KV. */
export async function storageCheck(storage: Storage): Promise<HealthCheck> {
  if (!hasKv(storage)) return { id: 'storage', status: 'ok', detail: `${storage.backend} (no key-value probe)` };
  const key = `health:probe:${crypto.randomUUID()}`;
  const value = { at: Date.now() };
  await storage.kvSet(key, value, { ttlSec: 60 });
  const back = await storage.kvGet<{ at: number }>(key);
  await storage.kvDelete(key);
  if (back?.at !== value.at)
    return { id: 'storage', status: 'fail', detail: `${storage.backend}: wrote a probe key but read back something else` };
  return { id: 'storage', status: 'ok', detail: `${storage.backend}: write, read and delete ok` };
}

/** At least one speech-to-text and one LLM rung is enabled under the current policy. */
export function rungsCheck(registry: Registry, env: Env): HealthCheck {
  const stt = rankRungs(registry.sttRungs(env), {}, env);
  const llm = rankRungs(registry.llmRungs(env), {}, env);
  const detail = `${stt.length} speech-to-text and ${llm.length} LLM rungs enabled${stt[0] ? `, first ${stt[0].id}` : ''}${llm[0] ? ` and ${llm[0].id}` : ''}`;
  if (stt.length === 0 || llm.length === 0) {
    return {
      id: 'rungs',
      status: 'fail',
      detail: `${detail}. Add a key or a local server (docs/providers.md), or allow keyless rungs (VID2CONTEXT_KEYLESS).`,
    };
  }
  return { id: 'rungs', status: 'ok', detail };
}

export interface HealthDeps {
  registry: Registry;
  storage: (ctx: Ctx) => Promise<Storage>;
  extra?: HealthChecks;
}

/** The runtime's own checks, or one failed check when they do not finish in time. */
async function runtimeChecks(extra: HealthChecks | undefined, ctx: Ctx, ms: number): Promise<HealthCheck[]> {
  if (!extra) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<HealthCheck[]>((resolve) => {
    timer = setTimeout(
      () => resolve([{ id: 'runtime', status: 'fail', detail: `runtime checks did not finish within ${ms} ms` }]),
      ms,
    );
  });
  try {
    return await Promise.race([
      extra(ctx).catch((err: unknown) => [
        { id: 'runtime', status: 'fail' as const, detail: err instanceof Error ? err.message : String(err) },
      ]),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A cached, single-flight deep health runner. */
export function createDeepHealth(deps: HealthDeps): (ctx: Ctx) => Promise<DeepHealth> {
  let cached: { at: number; value: DeepHealth } | undefined;
  let running: Promise<DeepHealth> | undefined;

  const compute = async (ctx: Ctx): Promise<DeepHealth> => {
    const { timeoutMs, required } = healthSettings(ctx.env);
    const env = ctx.env;
    const [storage, rungs, extra] = await Promise.all([
      withDeadline('storage', timeoutMs, async () => storageCheck(await deps.storage(ctx))),
      withDeadline('rungs', timeoutMs, async () => rungsCheck(deps.registry, env)),
      runtimeChecks(deps.extra, ctx, timeoutMs * 2),
    ]);
    const checks = [storage, rungs, ...extra];
    const marked = checks.map((c) => ({ ...c, required: required.has(c.id) }));
    const failed = marked.some((c) => c.required && c.status === 'fail');
    const degraded = marked.some((c) => c.status !== 'ok');
    return {
      ok: !failed,
      status: failed ? 'fail' : degraded ? 'degraded' : 'ok',
      checkedAt: new Date().toISOString(),
      checks: marked,
    };
  };

  return async (ctx) => {
    const { cacheMs } = healthSettings(ctx.env);
    if (cached && Date.now() - cached.at < cacheMs) return cached.value;
    running ??= compute({ ...ctx, signal: undefined }).then(
      (value) => {
        cached = { at: Date.now(), value };
        running = undefined;
        return value;
      },
      (err) => {
        running = undefined;
        throw err;
      },
    );
    return running;
  };
}
