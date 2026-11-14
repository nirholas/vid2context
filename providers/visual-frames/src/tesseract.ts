/**
 * Local OCR with tesseract.js (WebAssembly). Runs in Node and the browser,
 * never on Workers (the package's workers entry leaves this rung out).
 * Nothing leaves the machine: the frame is read in-process.
 *
 * tesseract.js is imported lazily on the first frame, so loading the provider
 * registry stays cheap. One worker per language set is kept warm between
 * frames and terminated after IDLE_MS without work, or by terminateTesseract().
 *
 * Only confident lines are kept (TESSERACT_MIN_CONFIDENCE, default 60, per
 * line), lines that are mostly symbols are dropped, and a frame with fewer than
 * MIN_TEXT_CHARS letters and digits in total yields no note: photos and faces
 * produce scattered low-confidence garbage that this filters out.
 */
import { type Ctx, type Env, Vid2ContextError, type VisualNote, type VisualRung } from '@vid2context/core';
import type { Frame } from './vision.ts';

export type TesseractLang = string | { code: string; data: Uint8Array };

/** Turns language codes into what tesseract.js createWorker takes, plus worker options (langPath, cachePath, cacheMethod). */
export type TesseractLangSource = (
  langs: string[],
  ctx: Ctx,
) => Promise<{ langs: TesseractLang[]; options: Record<string, unknown> }>;

/** Default source: language codes fetched by tesseract.js (from TESSERACT_LANG_PATH when set, else its CDN). */
export const cdnLangSource: TesseractLangSource = async (langs, ctx) => ({
  langs,
  options: ctx.env.TESSERACT_LANG_PATH ? { langPath: ctx.env.TESSERACT_LANG_PATH } : {},
});

export const DEFAULT_MIN_CONFIDENCE = 60;
export const MIN_TEXT_CHARS = 12;
const IDLE_MS = 15_000;

export function tesseractLangs(env: Env): string[] {
  const langs = (env.TESSERACT_LANGS || 'eng')
    .split(/[\s,+]+/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_]{2,16}$/.test(s));
  return langs.length > 0 ? [...new Set(langs)] : ['eng'];
}

export function tesseractEnabled(env: Env): boolean {
  const v = (env.TESSERACT_ENABLED ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

function minConfidence(env: Env): number {
  const n = Number(env.TESSERACT_MIN_CONFIDENCE);
  return env.TESSERACT_MIN_CONFIDENCE && Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_MIN_CONFIDENCE;
}

interface OcrLine {
  text: string;
  confidence: number;
}
interface OcrBlock {
  paragraphs: { lines: OcrLine[] }[];
}

function alnumCount(s: string): number {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/** Keep confident, mostly-alphanumeric lines; paragraphs are separated by a blank line. */
export function textFromBlocks(blocks: OcrBlock[] | null | undefined, minConf = DEFAULT_MIN_CONFIDENCE): string {
  const paragraphs: string[] = [];
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs) {
      const lines = para.lines
        .filter((l) => {
          const t = l.text.trim();
          const visible = t.replace(/\s+/g, '').length;
          const alnum = alnumCount(t);
          return l.confidence >= minConf && alnum >= 2 && alnum / Math.max(1, visible) >= 0.5;
        })
        .map((l) => l.text.trim());
      if (lines.length > 0) paragraphs.push(lines.join('\n'));
    }
  }
  return paragraphs.join('\n\n');
}

// ---------------------------------------------------------------- worker pool

interface TessWorker {
  recognize(image: unknown, options?: Record<string, unknown>, output?: Record<string, boolean>): Promise<{ data: { blocks: OcrBlock[] | null } }>;
  terminate(): Promise<unknown>;
}
interface TessModule {
  createWorker(langs: TesseractLang[], oem: number, options: Record<string, unknown>): Promise<TessWorker>;
}

interface PoolEntry {
  worker: Promise<TessWorker>;
  timer?: ReturnType<typeof setTimeout>;
}
const pool = new Map<string, PoolEntry>();

async function loadTesseract(): Promise<TessModule> {
  const mod = (await import('tesseract.js')) as unknown as TessModule & { default?: TessModule };
  return mod.default?.createWorker ? mod.default : mod;
}

function scheduleIdle(key: string, entry: PoolEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (pool.get(key) === entry) pool.delete(key);
    void entry.worker.then((w) => w.terminate()).catch(() => {});
  }, IDLE_MS);
  // Do not keep a Node process alive just for the idle timer.
  (entry.timer as { unref?: () => void }).unref?.();
}

function getWorker(langs: string[], source: TesseractLangSource, ctx: Ctx): PoolEntry {
  const key = langs.join('+');
  const hit = pool.get(key);
  if (hit) return hit;
  const entry: PoolEntry = {
    worker: (async () => {
      const T = await loadTesseract();
      const { langs: data, options } = await source(langs, ctx);
      // OEM 1 = LSTM only, the model the 4.0.0_best_int traineddata is built for.
      return T.createWorker(data, 1, { ...options, errorHandler: (e: unknown) => ctx.log.debug('tesseract worker error', { error: String(e) }) });
    })(),
  };
  entry.worker.catch(() => {
    if (pool.get(key) === entry) pool.delete(key);
  });
  pool.set(key, entry);
  return entry;
}

/** Terminate every warm tesseract worker. The frame pipeline calls this when it finishes so Node can exit. */
export async function terminateTesseract(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.all(
    entries.map(async (e) => {
      if (e.timer) clearTimeout(e.timer);
      try {
        await (await e.worker).terminate();
      } catch {
        // a worker that failed to start has nothing to terminate
      }
    }),
  );
}

export async function readWithTesseract(
  langs: string[],
  source: TesseractLangSource,
  rungId: string,
  frame: Frame,
  ctx: Ctx,
): Promise<VisualNote[]> {
  if (ctx.runtime === 'workers') {
    throw new Vid2ContextError('no-provider', 'tesseract.js does not run on Cloudflare Workers.', {
      hint: 'Use a vision rung (Gemini or keyless OVH) on Workers, or run OCR in Node or the browser.',
    });
  }
  const entry = getWorker(langs, source, ctx);
  let worker: TessWorker;
  try {
    worker = await entry.worker;
  } catch (err) {
    throw new Vid2ContextError('unavailable', `tesseract.js could not start for ${langs.join('+')}: ${String(err)}`, {
      hint: 'Check TESSERACT_LANGS (tesseract language codes such as eng, deu, ces) and the network for the first download, or set TESSERACT_LANG_PATH.',
      cause: err,
    });
  }
  const image = ctx.runtime === 'browser' ? new Blob([frame.data as Uint8Array<ArrayBuffer>], { type: frame.mimeType }) : frame.data;
  try {
    const { data } = await worker.recognize(image, {}, { blocks: true, text: false });
    const text = textFromBlocks(data.blocks, minConfidence(ctx.env));
    if (alnumCount(text) < MIN_TEXT_CHARS) return [];
    return [{ atSec: frame.atSec, kind: 'ocr', text, producer: rungId }];
  } finally {
    scheduleIdle(langs.join('+'), entry);
  }
}

export function tesseractRungs(env: Env, source: TesseractLangSource, providerId: string): VisualRung[] {
  const langs = tesseractLangs(env);
  const id = `visual/tesseract/${langs.join('+')}`;
  const enabled = tesseractEnabled(env);
  return [
    {
      id,
      provider: providerId,
      service: 'tesseract',
      model: langs.join('+'),
      tier: 'local',
      // After a configured local vision model (priority 10): when someone sets OLLAMA_VISION_MODEL they want it used.
      priority: 20,
      quality: 2,
      capabilities: ['ocr'],
      requires: [],
      isEnabled: () => enabled,
      read: (frame, ctx) => readWithTesseract(langs, source, id, frame, ctx),
    },
  ];
}
