/**
 * Batch downloads, Node side: expand playlists and channels with the
 * registry's `listItems` (core `expandInput`), save each video as video,
 * audio or captions one after another, report a status per item, keep going
 * past failures, and optionally pack every saved file into one .zip.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type Ctx, expandInput, type Registry, Vid2ContextError } from '@vid2context/core';
import type { BatchItem, BatchRequest } from '../batch.ts';
import type { CaptionsRequest } from '../captions.ts';
import { toolkitLimits } from '../limits.ts';
import type { DownloadRequest } from '../options.ts';
import { downloadPolicy } from '../policy.ts';
import { mb } from '../summary.ts';
import type { TaskOptions, TaskResult, ToolkitFile } from '../toolkit.ts';
import type { Downloader } from '../types.ts';
import { freeName } from './files.ts';
import { zipFiles } from './zipfile.ts';

export interface BatchDeps {
  registry: Registry;
  downloader: Downloader;
  captions: (req: CaptionsRequest, ctx: Ctx, opts: TaskOptions) => Promise<ToolkitFile>;
}

function errorOf(err: unknown): NonNullable<BatchItem['error']> {
  const e = err instanceof Vid2ContextError ? err : undefined;
  return {
    code: e?.code ?? 'upstream',
    message: err instanceof Error ? err.message : String(err),
    ...(e?.hint ? { hint: e.hint } : {}),
  };
}

/** The videos of a batch: single videos as given, lists expanded, at most `limit` in total. */
export async function expandBatch(registry: Registry, req: BatchRequest, ctx: Ctx, notes: string[]): Promise<string[]> {
  const out: string[] = [];
  const limit = Math.min(req.limit, toolkitLimits(ctx.env).maxBatchItems);
  for (const input of req.inputs) {
    if (out.length >= limit) {
      notes.push(`Stopped at ${limit} items (the batch limit); ${input} and later inputs were not read.`);
      break;
    }
    const resolved = registry.resolve(input);
    if (resolved.ref.kind === 'video' && !(req.playlist && resolved.list)) {
      if (!out.includes(input)) out.push(input);
      continue;
    }
    const refs = await expandInput(registry, input, ctx, { limit: limit - out.length, list: req.playlist });
    for (const r of refs) {
      const item = r.url ?? r.id;
      if (!out.includes(item) && out.length < limit) out.push(item);
    }
    notes.push(`${input}: ${refs.length} video${refs.length === 1 ? '' : 's'}`);
  }
  return out;
}

export function createBatchEngine(deps: BatchDeps) {
  async function batch(req: BatchRequest, ctx: Ctx, opts: TaskOptions): Promise<TaskResult> {
    const notes: string[] = [];
    opts.onProgress?.({ phase: 'preparing', downloadedBytes: 0, step: 'Listing' });
    const inputs = await expandBatch(deps.registry, req, ctx, notes);
    if (inputs.length === 0) {
      throw new Vid2ContextError('not-found', 'The batch has no videos (the playlists and channels were empty).', {
        hint: 'Check the URLs, or list them first (vid2context list <url>).',
      });
    }
    const items: BatchItem[] = inputs.map((input, index) => ({ index, input, status: 'queued' }));
    const paths: (string | undefined)[] = inputs.map(() => undefined);
    const emit = () => opts.onItems?.(items.map((i) => ({ ...i })));
    emit();
    // Item files go into a subfolder when they will be zipped, so only the .zip lands in `dir`.
    const itemDir = req.zip ? join(opts.dir, `.batch-${Date.now()}`) : opts.dir;
    await mkdir(itemDir, { recursive: true });
    const overall = (i: number, percent: number) => Math.round(((i + percent / 100) / inputs.length) * 1000) / 10;

    try {
      for (const [i, input] of inputs.entries()) {
        const item = items[i] as BatchItem;
        if (ctx.signal?.aborted) break;
        item.status = 'running';
        emit();
        let last = 0;
        const itemOpts: TaskOptions = {
          ...opts,
          dir: itemDir,
          onProgress: (p) => {
            item.progress = p;
            const now = Date.now();
            if (p.phase !== 'finished' && now - last < 250) return;
            last = now;
            opts.onProgress?.({
              ...p,
              percent: overall(i, p.percent ?? 0),
              step: `${i + 1}/${inputs.length}${p.step ? ` ${p.step}` : ''}`,
            });
            emit();
          },
        };
        try {
          const file =
            req.item.kind === 'captions'
              ? await deps.captions({ ...(req.item as Omit<CaptionsRequest, 'input'>), input }, ctx, itemOpts)
              : await deps.downloader.download({ ...(req.item as Omit<DownloadRequest, 'input'>), input }, ctx, itemOpts);
          paths[i] = file.path;
          item.status = 'done';
          item.file = {
            filename: file.filename,
            bytes: file.bytes,
            mimeType: file.mimeType,
            title: file.title,
            warnings: file.warnings,
          };
        } catch (err) {
          if (ctx.signal?.aborted) {
            item.status = 'canceled';
            break;
          }
          item.status = 'error';
          item.error = errorOf(err);
        }
        delete item.progress;
        emit();
      }
      if (ctx.signal?.aborted) {
        for (const item of items) if (item.status === 'queued' || item.status === 'running') item.status = 'canceled';
        emit();
        throw ctx.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }

      const done = items.filter((i) => i.status === 'done');
      const failed = items.filter((i) => i.status === 'error');
      if (done.length === 0) {
        const first = failed[0]?.error;
        throw new Vid2ContextError(
          (first?.code as Vid2ContextError['code'] | undefined) ?? 'upstream',
          `None of the ${items.length} items could be saved. First error: ${first?.message ?? 'unknown'}`,
          { hint: first?.hint ?? 'Check each item in the job for its error.' },
        );
      }
      const warnings = [...notes];
      if (failed.length > 0) warnings.push(`${failed.length} of ${items.length} items failed; see items for each error.`);

      if (req.zip) {
        const total = done.reduce((n, i) => n + (i.file?.bytes ?? 0), 0);
        const policy = downloadPolicy(ctx.env);
        if (policy.maxBytes > 0 && total > policy.maxBytes) {
          throw new Vid2ContextError(
            'too-large',
            `The saved files add up to ${mb(total)}; one .zip may be at most ${mb(policy.maxBytes)} here.`,
            { hint: 'Download without zip (each item is served on its own), or raise VID2CONTEXT_MAX_DOWNLOAD_MB.' },
          );
        }
        opts.onProgress?.({ phase: 'processing', step: 'Zip', downloadedBytes: total, percent: 100 });
        const used = new Set<string>();
        const files = done.map((i) => {
          let name = i.file?.filename ?? `item-${i.index + 1}`;
          for (let n = 2; used.has(name); n++) name = (i.file?.filename ?? '').replace(/(\.[^.]+)?$/, (ext) => ` (${n})${ext}`);
          used.add(name);
          return { path: paths[i.index] as string, name };
        });
        const zipName = await freeName(opts.dir, `vid2context batch ${new Date().toISOString().slice(0, 10)}.zip`);
        const dest = join(opts.dir, zipName);
        const bytes = await zipFiles(files, dest, ctx.signal);
        opts.onProgress?.({ phase: 'finished', percent: 100, downloadedBytes: bytes, totalBytes: bytes });
        return {
          file: {
            path: dest,
            filename: zipName,
            bytes,
            mimeType: 'application/zip',
            kind: 'batch',
            format: 'zip',
            title: `${done.length} of ${items.length} items`,
            source: req.inputs.join(' '),
            entries: files.map((f, n) => ({ name: f.name, bytes: done[n]?.file?.bytes ?? 0 })),
            warnings,
          },
          items,
        };
      }
      opts.onProgress?.({ phase: 'finished', percent: 100, downloadedBytes: done.reduce((n, i) => n + (i.file?.bytes ?? 0), 0) });
      return { items, itemPaths: paths, warnings };
    } finally {
      if (req.zip) await rm(itemDir, { recursive: true, force: true });
    }
  }

  return { batch };
}
