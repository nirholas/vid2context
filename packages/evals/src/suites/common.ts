/**
 * Pieces every suite shares: the run context, resolving a dataset item's
 * reference transcript, getting audio, and choosing which rungs to score.
 */
import {
  type Ctx,
  fetchAudioBytes,
  getVideoContext,
  isRungEnabled,
  keylessAllowed,
  type Registry,
  type SttRung,
  Vid2ContextError,
  type VideoRef,
} from '@vid2context/core';
import { type AudioBytes, readCachedAudio, writeCachedAudio } from '../cache.ts';
import type { VideoItem } from '../dataset.ts';
import { findRef, type RecordedRef, refFromTranscript, saveRef } from '../refs.ts';
import type { SkippedRung } from '../results.ts';

export interface SuiteContext {
  registry: Registry;
  ctx: Ctx;
  /** .vid2context/cache/evals */
  cacheDir: string;
  /** Committed references (datasets/refs). */
  refsDir: string;
  /** Write fetched references into `refsDir` instead of the cache. */
  record: boolean;
  limit?: number;
  /** Rung ids, services or providers named with --rungs. */
  rungs?: string[];
}

export function errorInfo(err: unknown): { reason: string; detail: string } {
  if (err instanceof Vid2ContextError) return { reason: err.code, detail: err.message.slice(0, 300) };
  return { reason: 'error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
}

/**
 * The creator-caption reference for an item: a committed file, then the
 * cache, then (live) a real caption download through the pipeline with
 * auto-captions disallowed. Returns null when the video has no creator track
 * in the item's language.
 */
export async function creatorReference(sc: SuiteContext, item: VideoItem, ref: VideoRef): Promise<RecordedRef | null> {
  const cacheRefs = `${sc.cacheDir}/refs`;
  const found = findRef([sc.refsDir, cacheRefs], ref.id, 'creator-captions', item.language);
  if (found) return found;
  const context = await getVideoContext(
    sc.registry,
    item.url,
    { mode: 'captions', language: item.language, allowAuto: false, storage: null },
    sc.ctx,
  );
  const t = context.transcript;
  if (t.origin !== 'creator-captions' || t.translated) return null;
  const rec = refFromTranscript(t, context.metadata.title);
  saveRef(sc.record ? sc.refsDir : cacheRefs, rec);
  return rec;
}

/**
 * Audio for a video: the cache first, then every registered source that can
 * supply audio for the ref (the pipeline's own rule: the resolving source
 * first, then others that say they can). Returns null with the reason when
 * no installed source can.
 */
export async function audioFor(sc: SuiteContext, ref: VideoRef): Promise<{ audio: AudioBytes; source: string } | { error: string }> {
  const cached = readCachedAudio(sc.cacheDir, ref.id);
  if (cached) return { audio: cached, source: cached.source };
  const { source } = sc.registry.resolve(ref.url ?? ref.input);
  const candidates = [source, ...sc.registry.sources().filter((s) => s !== source)].filter(
    (s) =>
      s.getAudio && (s === source ? (s.canProvideAudio?.(ref, sc.ctx) ?? true) : (s.canProvideAudio?.(ref, sc.ctx) ?? false)),
  );
  if (candidates.length === 0) {
    return { error: `no installed source can supply audio for ${ref.platform} (the yt-dlp provider covers YouTube)` };
  }
  const failures: string[] = [];
  for (const s of candidates) {
    try {
      const raw = await s.getAudio?.(ref, sc.ctx);
      if (!raw) continue;
      const audio = await fetchAudioBytes(raw, sc.ctx);
      writeCachedAudio(sc.cacheDir, ref.id, audio, s.id);
      return { audio, source: s.id };
    } catch (err) {
      failures.push(`${s.id}: ${errorInfo(err).detail}`);
    }
  }
  return { error: `audio download failed (${failures.join('; ') || 'no audio returned'})` };
}

/**
 * Rungs to score. With --rungs: each named rung (paid included) when its key
 * is set, else skipped with the env vars it needs. Without: every enabled
 * local, free and keyless rung, each scored on its own; paid rungs only run
 * when named.
 */
export function selectSttRungs(sc: SuiteContext): { rungs: SttRung[]; skipped: SkippedRung[] } {
  const env = sc.ctx.env;
  const all = sc.registry.sttRungs(env);
  const skipped: SkippedRung[] = [];
  const usable = (r: SttRung): boolean => {
    if (!isRungEnabled(r, env)) {
      skipped.push({ rung: r.id, reason: 'not enabled (missing key)', envVars: r.requires });
      return false;
    }
    if (r.tier === 'keyless' && !keylessAllowed(env)) {
      skipped.push({ rung: r.id, reason: 'keyless rungs are off (VID2CONTEXT_KEYLESS=0)' });
      return false;
    }
    return true;
  };
  if (sc.rungs && sc.rungs.length > 0) {
    const picked: SttRung[] = [];
    for (const name of sc.rungs) {
      const matches = all.filter((r) => r.id === name || r.service === name || r.provider === name);
      if (matches.length === 0) skipped.push({ rung: name, reason: 'unknown rung (not in the installed stt providers)' });
      for (const r of matches) if (!picked.includes(r) && usable(r)) picked.push(r);
    }
    return { rungs: picked, skipped };
  }
  const rungs = all.filter((r) => {
    if (r.tier === 'paid') {
      skipped.push({ rung: r.id, reason: 'paid rungs run only when named with --rungs', envVars: r.requires });
      return false;
    }
    return usable(r);
  });
  return { rungs, skipped };
}

export function limited<T>(items: readonly T[], limit?: number): T[] {
  return limit && limit > 0 ? items.slice(0, limit) : [...items];
}
