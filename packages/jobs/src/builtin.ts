/**
 * Built-in job kinds:
 *   context  one input to a VideoContext saved to storage
 *   items    expand a playlist, channel or feed and fetch every video
 *   bundle   fetch one or more inputs and build the agent bundle (core buildBundle)
 * All three are idempotent: contexts already in storage are cache hits, so a
 * job resumed after a crash redoes only what was not saved yet.
 */
import {
  buildBundle,
  expandInput,
  type GetContextOptions,
  getVideoContext,
  summarize,
  type TranscriptMode,
  Vid2ContextError,
  type VideoContext,
  type VideoRef,
} from '@vid2context/core';
import { publicError, toJobError } from './retry.ts';
import type { ItemEvent, JobHandler, JobQueue } from './types.ts';

const MODES: TranscriptMode[] = ['auto', 'captions', 'stt', 'video'];

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function inputString(input: unknown, what: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw bad(`The ${what} job needs "input" to be a non-empty string.`, 'Pass a video, playlist, channel or feed URL as input.');
  }
  return input.trim();
}

function intOption(options: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const v = options[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw bad(`Option "${name}" must be an integer from ${min} to ${max}.`, `Pass "${name}": ${min} or omit it.`);
  }
  return v;
}

/** The pipeline options a job may set. Everything else in `options` is ignored here. */
export function contextOptions(
  options: Record<string, unknown>,
): Pick<GetContextOptions, 'mode' | 'language' | 'allowAuto' | 'comments' | 'refresh'> {
  const out: Pick<GetContextOptions, 'mode' | 'language' | 'allowAuto' | 'comments' | 'refresh'> = {};
  if (options.mode !== undefined) {
    if (!MODES.includes(options.mode as TranscriptMode))
      throw bad(`Unknown mode "${String(options.mode)}".`, `Use one of: ${MODES.join(', ')}.`);
    out.mode = options.mode as TranscriptMode;
  }
  if (options.language !== undefined) {
    if (typeof options.language !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(options.language)) {
      throw bad(`Invalid language "${String(options.language)}".`, 'Pass a BCP-47 tag such as "en" or "pt-BR".');
    }
    out.language = options.language;
  }
  if (options.allowAuto !== undefined) out.allowAuto = options.allowAuto !== false;
  if (options.refresh !== undefined) out.refresh = options.refresh === true;
  if (options.comments !== undefined) {
    if (typeof options.comments === 'boolean') out.comments = options.comments;
    else out.comments = intOption(options, 'comments', 1, 10_000);
  }
  return out;
}

/** What a finished context job returns. The full VideoContext is in storage (GET /api/v1/context serves it from there). */
export interface ContextJobResult {
  video: ReturnType<typeof summarize>;
  segments: number;
  url?: string;
}

export const contextKind: JobHandler = async ({ input, options, registry, storage, ctx, progress }) => {
  const url = inputString(input, 'context');
  const opts = contextOptions(options);
  let done = 0;
  const context = await getVideoContext(
    registry,
    url,
    {
      ...opts,
      storage,
      onProgress: (e) => progress({ done: ++done, message: e.detail ? `${e.stage}: ${e.detail}` : e.stage }),
    },
    ctx,
  );
  const result: ContextJobResult = {
    video: summarize(context, new Date().toISOString()),
    segments: context.transcript.segments.length,
    ...(context.metadata.ref.url ? { url: context.metadata.ref.url } : {}),
  };
  return result;
};

/** Run `fn` over `items` with at most `limit` in flight, keeping input order in the output. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      signal.throwIfAborted();
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface ItemsJobResult {
  input: string;
  total: number;
  succeeded: number;
  failed: number;
  items: ItemEvent[];
}

function videoInput(ref: VideoRef): string {
  return ref.url ?? ref.nativeId;
}

/** Fetch every ref, emitting item and progress events. Returns the contexts that succeeded, in order. */
async function fetchAll(
  refs: VideoRef[],
  concurrency: number,
  args: Parameters<JobHandler>[0],
): Promise<{ items: ItemEvent[]; contexts: VideoContext[] }> {
  const { registry, storage, ctx, signal, progress, item } = args;
  const opts = contextOptions(args.options);
  let done = 0;
  const contexts: (VideoContext | null)[] = new Array(refs.length).fill(null);
  const items = await mapLimit(refs, concurrency, signal, async (ref, i) => {
    let event: ItemEvent;
    try {
      const context = await getVideoContext(registry, videoInput(ref), { ...opts, storage }, ctx);
      contexts[i] = context;
      event = { id: ref.id, outcome: 'ok', title: context.metadata.title };
    } catch (err) {
      if (signal.aborted) throw err;
      event = { id: ref.id, outcome: 'error', error: publicError(toJobError(err)) };
    }
    item(event);
    done += 1;
    progress({ done, total: refs.length, message: `${ref.id}: ${event.outcome}` });
    return event;
  });
  return { items, contexts: contexts.filter((c): c is VideoContext => c !== null) };
}

function allFailed(items: ItemEvent[]): Vid2ContextError {
  const first = items.find((i) => i.error)?.error;
  const code = (first?.code ?? 'no-transcript') as Vid2ContextError['code'];
  return new Vid2ContextError(code, `All ${items.length} items failed. First failure: ${first?.message ?? 'unknown'}`, {
    hint: first?.hint ?? 'Check each item event for why it failed.',
  });
}

export const itemsKind: JobHandler = async (args) => {
  const { input, options, registry, ctx, progress } = args;
  const list = inputString(input, 'items');
  const limit = intOption(options, 'limit', 1, 5_000);
  const concurrency = intOption(options, 'concurrency', 1, 8) ?? 2;
  progress({ done: 0, message: `expanding ${list}` });
  const refs = await expandInput(registry, list, ctx, limit ? { limit } : {});
  if (refs.length === 0) {
    throw new Vid2ContextError('not-found', `"${list}" lists no videos.`, {
      hint: 'Check that the playlist, channel or feed is public and not empty.',
    });
  }
  progress({ done: 0, total: refs.length, message: `found ${refs.length} videos` });
  const { items } = await fetchAll(refs, concurrency, args);
  const succeeded = items.filter((i) => i.outcome === 'ok').length;
  if (succeeded === 0) throw allFailed(items);
  const result: ItemsJobResult = { input: list, total: items.length, succeeded, failed: items.length - succeeded, items };
  return result;
};

export interface BundleJobResult {
  filename: string;
  root: string;
  manifest: Awaited<ReturnType<typeof buildBundle>>['manifest'];
  /** Every bundle file. UTF-8 files as text; anything else base64. */
  files: { path: string; mimeType: string; encoding: 'utf-8' | 'base64'; content: string }[];
  items: ItemEvent[];
}

function fileContent(bytes: Uint8Array): { encoding: 'utf-8' | 'base64'; content: string } {
  try {
    return { encoding: 'utf-8', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return { encoding: 'base64', content: btoa(bin) };
  }
}

/** Input: one input string or an array of them (videos or lists). Options: the context options, plus `formats`, `maxTokens`, `name`, `limit`, `concurrency`. */
export const bundleKind: JobHandler = async (args) => {
  const { input, options, registry, ctx, progress } = args;
  const inputs = (Array.isArray(input) ? input : [input]).map((i) => inputString(i, 'bundle'));
  if (inputs.length === 0 || inputs.length > 200)
    throw bad('The bundle job takes 1 to 200 inputs.', 'Pass "input" as a URL or an array of URLs.');
  const limit = intOption(options, 'limit', 1, 5_000);
  const concurrency = intOption(options, 'concurrency', 1, 8) ?? 2;
  const formats = options.formats;
  if (formats !== undefined && !(Array.isArray(formats) && formats.every((f) => typeof f === 'string'))) {
    throw bad(
      'Option "formats" must be an array of formatter ids.',
      'Omit it for every format, or pass for example ["markdown", "srt"].',
    );
  }
  progress({ done: 0, message: 'expanding inputs' });
  const refs: VideoRef[] = [];
  const seen = new Set<string>();
  for (const one of inputs) {
    for (const ref of await expandInput(registry, one, ctx, limit ? { limit } : {})) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      refs.push(ref);
    }
  }
  if (refs.length === 0) throw new Vid2ContextError('not-found', 'The inputs list no videos.', { hint: 'Check the URLs.' });
  progress({ done: 0, total: refs.length, message: `found ${refs.length} videos` });
  const { items, contexts } = await fetchAll(refs, concurrency, args);
  if (contexts.length === 0) throw allFailed(items);
  const bundle = await buildBundle(contexts, {
    ...(formats ? { formats: formats as string[] } : {}),
    ...(typeof options.maxTokens === 'number' ? { maxTokens: options.maxTokens } : {}),
    ...(typeof options.name === 'string' ? { name: options.name } : {}),
  });
  const result: BundleJobResult = {
    filename: bundle.filename,
    root: bundle.root,
    manifest: bundle.manifest,
    files: bundle.files.map((f) => ({ path: f.path, mimeType: f.mimeType, ...fileContent(f.bytes) })),
    items,
  };
  return result;
};

/** Register `context`, `items` and `bundle` on a queue. */
export function registerBuiltinKinds(queue: Pick<JobQueue, 'registerKind'>): void {
  queue.registerKind('context', contextKind);
  queue.registerKind('items', itemsKind);
  queue.registerKind('bundle', bundleKind);
}
