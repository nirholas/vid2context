/**
 * Client-only transcription: runs the browser registry's speech-to-text
 * chain on the decoded audio, with the user's own keys from Settings as env.
 * The Transformers.js Whisper rung (local tier) runs first; it downloads its
 * model from huggingface.co once and caches it in the browser. Rungs for
 * hosted services join the chain only when their key is saved in Settings.
 *
 * Loaded on demand, so none of this is in the initial bundle.
 */
import { type Attempt, transcribe, type VideoContext, type VideoRef } from '@vid2context/core';
import { DEFAULT_MODEL, onProgress, type ProgressEvent } from '@vid2context/provider-stt-transformers';
import { createBrowserContext, createRegistry } from '@vid2context/registry/browser';
import type { Prepared } from './prepare.ts';

export interface ModelProgress {
  /** 0..100 when known. */
  percent?: number;
  status: string;
  file?: string;
}

export function localRef(prepared: Pick<Prepared, 'sha256' | 'file'>): VideoRef {
  return {
    input: prepared.file.name,
    platform: 'file',
    kind: 'video',
    id: `file:${prepared.sha256}`,
    nativeId: prepared.sha256,
  };
}

/** The input string a client-only result is stored and reopened under. */
export function localInput(sha256: string): string {
  return `file:${sha256}`;
}

export async function transcribeInBrowser(
  prepared: Prepared,
  opts: { lang?: string; keys: Record<string, string>; decodeMs: number; onModel?: (p: ModelProgress) => void },
  signal?: AbortSignal,
): Promise<VideoContext> {
  const env = { TRANSFORMERS_STT_MODEL: DEFAULT_MODEL, ...opts.keys };
  const ctx = createBrowserContext(env, signal);
  const registry = createRegistry();
  const ref = localRef(prepared);
  const off = onProgress((e: ProgressEvent) => {
    if (e.status === 'progress_total' || e.status === 'progress') {
      opts.onModel?.({ status: 'downloading', percent: typeof e.progress === 'number' ? e.progress : undefined, file: e.file });
    } else if (e.status === 'ready') {
      opts.onModel?.({ status: 'ready' });
    }
  });
  const decodeAttempt: Attempt = {
    id: 'web/decode',
    stage: 'audio',
    outcome: 'ok',
    detail: `decoded in the browser to ${prepared.sampleRate} Hz mono, ${prepared.durationSec.toFixed(1)} s`,
    ms: opts.decodeMs,
  };
  try {
    const { transcript, attempts } = await transcribe(
      registry,
      ref,
      { kind: 'bytes', data: prepared.wav, mimeType: 'audio/wav', filename: `${prepared.sha256}.wav`, durationSec: prepared.durationSec },
      { stt: opts.lang ? { language: opts.lang } : {} },
      ctx,
    );
    return {
      metadata: { ref, title: prepared.file.name, durationSec: prepared.durationSec, chapters: [] },
      transcript,
      attempts: [decodeAttempt, ...attempts],
    };
  } catch (err) {
    const tried = (err as { attempts?: Attempt[] }).attempts ?? [];
    throw Object.assign(err as object, { attempts: [decodeAttempt, ...tried] });
  } finally {
    off();
  }
}
