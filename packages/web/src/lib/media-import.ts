/**
 * Getting a transcript from the video itself when the server's normal run
 * failed (docs/contracts/transcript-import.md, "Media in the web app"):
 *
 *   - a media file from the user's device, transcribed in this browser
 *     (Whisper via Transformers.js, plus hosted rungs whose keys are saved in
 *     Settings) or on the server (POST /uploads, then GET /context);
 *   - audio the server downloads with yt-dlp (POST /downloads), which often
 *     still works when YouTube refuses the caption requests, fetched into the
 *     browser and transcribed the same way.
 *
 * The segments then go to POST /imports with via=media, so the result
 * belongs to the video's link and carries its real metadata.
 */
import { type Attempt, type ErrorCode, type Transcript, Vid2ContextError } from '@vid2context/core';
import type { Prepared, PrepareStage } from '../audio/prepare.ts';
import { apiBase, type CallOptions, getContext, uploadFile } from './api.ts';
import { type DownloadJob, downloadFileUrl, getDownloadJob, isFinished, phaseLabel, startDownload } from './downloads.ts';
import { isAbort } from './errors.ts';
import { formatBytes } from './format.ts';
import { type ImportRequest, youtubeVideoId } from './imports.ts';
import { loadProviderKeys } from './settings.ts';

export type TranscribeWhere = 'browser' | 'server';

/** One line of progress, with a percentage when it is known. */
export interface MediaStep {
  label: string;
  percent?: number;
}

export interface MediaTranscript {
  segments: { startSec: number; endSec: number; text: string }[];
  /** BCP 47, or undefined when the model did not say. */
  language?: string;
  /** The speech-to-text rung that made the segments. */
  transcriber?: string;
  durationSec: number;
}

const PREPARE_LABELS: Record<PrepareStage['stage'], string> = {
  reading: 'Reading the file',
  decoding: 'Decoding the audio',
  encoding: 'Converting to 16 kHz mono',
};

function prepareStep(s: PrepareStage): MediaStep {
  return s.stage === 'reading'
    ? { label: PREPARE_LABELS.reading, percent: s.total ? (s.loaded / s.total) * 100 : undefined }
    : { label: PREPARE_LABELS[s.stage] };
}

/** The id of the speech-to-text rung that succeeded, from a run's attempts. */
export function transcriberOf(attempts: Attempt[]): string | undefined {
  return attempts.findLast((a) => a.stage === 'stt' && a.outcome === 'ok')?.id;
}

/** Keep what POST /imports accepts: non-empty text, finite times. Throws no-transcript when nothing is left. */
export function toMediaTranscript(transcript: Transcript, attempts: Attempt[], durationSec: number): MediaTranscript {
  const segments = transcript.segments
    .map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text && Number.isFinite(s.startSec) && s.startSec >= 0 && Number.isFinite(s.endSec));
  if (segments.length === 0) {
    throw new Vid2ContextError('no-transcript', 'No speech was found in the audio.', {
      hint: 'Check that the file has a spoken soundtrack. Music-only or silent videos give no transcript.',
    });
  }
  const language = transcript.language && transcript.language !== 'und' ? transcript.language : undefined;
  const transcriber = transcriberOf(attempts);
  return { segments, ...(language ? { language } : {}), ...(transcriber ? { transcriber } : {}), durationSec };
}

/** The POST /imports body for a transcript made from the media. `lang` (what the run asked for) wins over the detected language. */
export function mediaImportBody(url: string, t: MediaTranscript, lang?: string): ImportRequest {
  const language = lang || t.language;
  return {
    url,
    segments: t.segments,
    via: 'media',
    ...(language ? { language } : {}),
    ...(t.transcriber ? { transcriber: t.transcriber } : {}),
  };
}

async function transcribeHere(
  prepared: Prepared,
  decodeMs: number,
  opts: { lang?: string; onStep: (s: MediaStep) => void },
  signal: AbortSignal,
): Promise<MediaTranscript> {
  opts.onStep({ label: 'Loading the speech model' });
  const [{ transcribeInBrowser }, keys] = await Promise.all([import('../audio/local.ts'), loadProviderKeys().catch(() => ({}))]);
  const context = await transcribeInBrowser(
    prepared,
    {
      lang: opts.lang,
      keys,
      decodeMs,
      onModel: (m) =>
        opts.onStep(
          m.status === 'ready'
            ? { label: `Transcribing ${Math.round(prepared.durationSec / 60) || 1} min of audio in this browser` }
            : { label: 'Downloading the speech model (once, then cached)', percent: m.percent },
        ),
    },
    signal,
  );
  if (!context.transcript) throw new Vid2ContextError('no-transcript', 'The speech model returned no transcript.');
  return toMediaTranscript(context.transcript, context.attempts, prepared.durationSec);
}

async function transcribeOnServer(
  prepared: Prepared,
  opts: { lang?: string; onStep: (s: MediaStep) => void },
  signal: AbortSignal,
): Promise<MediaTranscript> {
  try {
    opts.onStep({ label: `Uploading ${formatBytes(prepared.upload.bytes)}`, percent: 0 });
    const up = await uploadFile(
      prepared.upload.blob,
      prepared.upload.filename,
      (loaded, total) => opts.onStep({ label: `Uploading ${formatBytes(total)}`, percent: (loaded / total) * 100 }),
      signal,
    );
    opts.onStep({ label: 'Transcribing on the server' });
    const context = await getContext(up.input, { lang: opts.lang }, { signal });
    if (!context.transcript) throw new Vid2ContextError('no-transcript', 'The server returned no transcript for the upload.');
    return toMediaTranscript(context.transcript, context.attempts, prepared.durationSec);
  } catch (err) {
    if (isAbort(err) || !(err instanceof Vid2ContextError)) throw err;
    // The upload or the server's speech-to-text chain failed: say how to get past it from here.
    throw Object.assign(
      new Vid2ContextError(err.code, err.message, {
        hint: `${err.hint ? `${err.hint} ` : ''}Or pick "On this device" to transcribe in this browser instead, with no server keys.`,
        status: err.status,
        retryAfterSec: err.retryAfterSec,
        cause: err,
      }),
      { attempts: (err as { attempts?: Attempt[] }).attempts ?? [] },
    );
  }
}

/** Decode a media file in the browser, then transcribe it where asked. */
export async function transcribeMedia(
  file: File,
  where: TranscribeWhere,
  opts: { lang?: string; onStep: (s: MediaStep) => void },
  signal: AbortSignal,
): Promise<MediaTranscript> {
  const { prepareFile } = await import('../audio/prepare.ts');
  const t0 = performance.now();
  const prepared = await prepareFile(file, (s) => opts.onStep(prepareStep(s)), signal);
  const decodeMs = Math.round(performance.now() - t0);
  signal.throwIfAborted();
  return where === 'browser' ? transcribeHere(prepared, decodeMs, opts, signal) : transcribeOnServer(prepared, opts, signal);
}

/** The error a failed or canceled download job ended with. */
export function jobError(job: DownloadJob): Vid2ContextError {
  if (job.status === 'canceled') return new Vid2ContextError('upstream', 'The download was canceled on the server.');
  const e = job.error ?? { code: 'upstream', message: 'The download failed.' };
  return new Vid2ContextError(e.code as ErrorCode, e.message, e.hint ? { hint: e.hint } : {});
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * Have the server download the video's audio as m4a (AAC decodes in every
 * browser) and wait for it. Reports each poll; resolves with the done job.
 */
export async function downloadAudioOnServer(
  url: string,
  opts: { onJob: (job: DownloadJob) => void; pollMs?: number; call?: Omit<CallOptions, 'signal'> },
  signal: AbortSignal,
): Promise<DownloadJob> {
  const call = { ...opts.call, signal };
  let job = await startDownload({ url, kind: 'audio', format: 'm4a', quality: 'best' }, call);
  opts.onJob(job);
  while (!isFinished(job)) {
    await wait(opts.pollMs ?? 1000, signal);
    job = await getDownloadJob(job.id, call);
    opts.onJob(job);
  }
  if (job.status !== 'done') throw jobError(job);
  return job;
}

/** One line for a running job: "Downloading 38%, 4.1 MB". */
export function jobStep(job: DownloadJob): MediaStep {
  return { label: `Server: ${phaseLabel(job)}`, percent: job.status === 'running' ? job.progress.percent : undefined };
}

/** Fetch a finished job's file into the browser, with progress. */
export async function fetchJobFile(
  job: DownloadJob,
  opts: { onStep: (s: MediaStep) => void; call?: Omit<CallOptions, 'signal'> },
  signal: AbortSignal,
): Promise<File> {
  const f = job.file;
  if (job.status !== 'done' || !f) throw jobError(job);
  const doFetch = opts.call?.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await doFetch(downloadFileUrl(job.id, false, opts.call?.base ?? apiBase()), { signal });
  if (!res.ok || !res.body) {
    throw new Vid2ContextError(
      res.status === 404 ? 'not-found' : 'upstream',
      `The server answered HTTP ${res.status} for the file.`,
      {
        hint:
          res.status === 404 ? 'The file expired on the server. Download it again.' : 'Try again, or save the file and pick it.',
        status: res.status,
      },
    );
  }
  const total = Number(res.headers.get('content-length')) || f.bytes;
  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array<ArrayBuffer>);
    loaded += value.byteLength;
    opts.onStep({
      label: `Fetching the audio from the server, ${formatBytes(loaded)}`,
      percent: total ? (loaded / total) * 100 : undefined,
    });
  }
  return new File(chunks, f.filename, { type: f.mimeType });
}

/**
 * A yt-dlp command that saves the best audio-only stream, which the browser
 * decodes and which is small to upload. The link is pasted into a shell, so a
 * YouTube link becomes its canonical form and any other link has the
 * characters that are live inside double quotes in bash and PowerShell
 * percent-encoded, so a crafted link cannot run anything.
 */
export function ytdlpCommand(url: string): string {
  const id = youtubeVideoId(url);
  const safe = id
    ? `https://www.youtube.com/watch?v=${id}`
    : url.trim().replace(/["$`\\!\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return `yt-dlp -f "bestaudio[ext=m4a]/bestaudio" -o "%(title)s [%(id)s].%(ext)s" "${safe}"`;
}
