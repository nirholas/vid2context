/**
 * Client-only transcription, as the upload view and the import panel call
 * it. The run itself (transcribe-core.ts) happens in a Web Worker
 * (transcribe.worker.ts), so decoding a long file's speech never freezes the
 * page, and aborting terminates the worker, which really stops Whisper. One
 * worker is kept between runs so the model loads once per page. When a
 * module worker cannot start (an old browser, a strict CSP), the same code
 * runs on the page instead.
 *
 * Loaded on demand, so none of this is in the initial bundle.
 */
import type { VideoContext, VideoRef } from '@vid2context/core';
import { localRefOf } from './local-ref.ts';
import type { Prepared } from './prepare.ts';
import type { LocalAudio, LocalOptions, ModelProgress } from './transcribe-core.ts';
import { deserializeError, type WorkerRequest, type WorkerResponse } from './worker-protocol.ts';

export type { ModelProgress };

export function localRef(prepared: Pick<Prepared, 'sha256' | 'file'>): VideoRef {
  return localRefOf({ sha256: prepared.sha256, name: prepared.file.name });
}

/** The input string a client-only result is stored and reopened under. */
export function localInput(sha256: string): string {
  return `file:${sha256}`;
}

let worker: Worker | null = null;
/** False once a worker failed to start here; later runs go straight to the page thread. */
let workersWork = typeof Worker !== 'undefined';
let nextId = 1;

function startWorker(): Worker {
  worker ??= new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module', name: 'vid2context-stt' });
  return worker;
}

function stopWorker(): void {
  worker?.terminate();
  worker = null;
}

class WorkerUnavailable extends Error {}

function inWorker(
  audio: LocalAudio,
  opts: LocalOptions,
  onModel: ((p: ModelProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<VideoContext> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    let w: Worker;
    try {
      w = startWorker();
    } catch (err) {
      reject(new WorkerUnavailable(String(err)));
      return;
    }
    const id = nextId++;
    let heard = false;
    const cleanup = () => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onMessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (m?.id !== id) return;
      heard = true;
      if (m.type === 'model') onModel?.(m.progress);
      else if (m.type === 'done') {
        cleanup();
        resolve(m.context as VideoContext);
      } else if (m.type === 'error') {
        cleanup();
        reject(deserializeError(m.error));
      }
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      stopWorker();
      e.preventDefault();
      // Before any message: the worker script never ran, so the page thread takes over.
      reject(
        heard
          ? new Error(`The speech-to-text worker stopped: ${e.message || 'unknown error'}`)
          : new WorkerUnavailable(e.message),
      );
    };
    const onAbort = () => {
      cleanup();
      // Terminating is the only way to stop a running Whisper inference; the next run starts a fresh worker.
      stopWorker();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    // A copy is transferred, so the caller keeps its WAV (the upload view still shows its size).
    const wav = audio.wav.slice();
    const msg: WorkerRequest = { type: 'run', id, audio: { ...audio, wav }, opts };
    w.postMessage(msg, [wav.buffer]);
  });
}

async function onPage(
  audio: LocalAudio,
  opts: LocalOptions,
  onModel: ((p: ModelProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<VideoContext> {
  const { transcribeLocal } = await import('./transcribe-core.ts');
  return transcribeLocal(audio, { ...opts, onModel }, signal);
}

export async function transcribeInBrowser(
  prepared: Prepared,
  opts: { lang?: string; keys: Record<string, string>; decodeMs: number; onModel?: (p: ModelProgress) => void },
  signal?: AbortSignal,
): Promise<VideoContext> {
  const audio: LocalAudio = {
    sha256: prepared.sha256,
    name: prepared.file.name,
    sampleRate: prepared.sampleRate,
    durationSec: prepared.durationSec,
    wav: prepared.wav,
  };
  const run: LocalOptions = { ...(opts.lang ? { lang: opts.lang } : {}), keys: opts.keys, decodeMs: opts.decodeMs };
  if (workersWork) {
    try {
      return await inWorker(audio, run, opts.onModel, signal);
    } catch (err) {
      if (!(err instanceof WorkerUnavailable)) throw err;
      workersWork = false;
      console.error('[vid2context] the speech-to-text worker could not start; transcribing on the page instead', err.message);
    }
  }
  return onPage(audio, run, opts.onModel, signal);
}
