/**
 * HTTP routes for the media toolkit, relative to /api/v1. `downloadsRoutes`
 * mounts them first, so these paths win over `/downloads/:id`, and task ids
 * fall through to the download routes when they are not toolkit tasks.
 *
 *   GET    /downloads/toolkit                  formats, defaults and limits for captions, frames, clips, batches
 *   GET    /downloads/captions/tracks?url=     every caption track, translation targets, notes
 *   POST   /downloads/captions                 captions only: 202 with a task job
 *   POST   /downloads/frames                   frame grabs at times (png/jpg): 202
 *   POST   /downloads/clips                    animated GIF or WebP of a short range: 202
 *   POST   /downloads/batch                    several URLs, playlists or channels: 202
 *   GET    /downloads                          download jobs and toolkit tasks, newest first
 *   GET    /downloads/:id                      a task (or a download) with progress and, for batches, items
 *   GET    /downloads/:id/file                 the task's result file (Range supported; ?inline=1)
 *   GET    /downloads/:id/items/:n/file        item n of a batch without zip
 *   DELETE /downloads/:id                      cancel a task (child processes are killed), or delete its files
 */
import { type Ctx, enforceInputPolicy, Vid2ContextError } from '@vid2context/core';
import { type Context, Hono } from 'hono';
import { LINE_CHARS_RANGE, LINES_RANGE } from '@vid2context/core';
import { CAPTION_MODES, CAPTION_VIA, captionFormatList } from './captions.ts';
import { ANIMATION_FORMATS, DEFAULT_CLIP_FPS, DEFAULT_CLIP_WIDTH, FRAME_FORMATS } from './clips.ts';
import { contentDisposition, type DownloadsRouteDeps, parseRange } from './http.ts';
import { toolkitLimits } from './limits.ts';
import { downloadPolicy } from './policy.ts';
import { normalizeToolkitRequest, type TaskQueue, type Toolkit, type ToolkitKind, toolkitOf } from './toolkit.ts';
import type { JobFile } from './types.ts';

const closeHooked = new WeakSet<object>();

async function readBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new Vid2ContextError('bad-request', 'The body must be JSON.', { hint: 'Send a JSON object, e.g. {"url": "..."}.' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Vid2ContextError('bad-request', 'The body must be a JSON object.', { hint: 'Send {"url": "..."}.' });
  }
  return body as Record<string, unknown>;
}

export function toolkitRoutes(deps: DownloadsRouteDeps): Hono {
  const app = new Hono();

  const toolkit = (ctx: Ctx): Toolkit => {
    const policy = downloadPolicy(ctx.env);
    if (!policy.enabled) {
      throw new Vid2ContextError('unavailable', policy.reason ?? 'Downloads are off.', {
        hint: 'Set VID2CONTEXT_DOWNLOADS=1 on the server, or run vid2context locally.',
      });
    }
    const tk = toolkitOf(deps.manager?.downloader);
    if (!deps.manager || !tk) {
      throw new Vid2ContextError(
        'no-provider',
        `Captions, frames, clips and batches need the Node downloader with a registry, which this ${ctx.runtime} server does not have.`,
        { hint: 'Run vid2context on Node (npx vid2context serve) or locally (npx vid2context captions <url>).' },
      );
    }
    return tk;
  };

  /** The task queue, without the enabled check (for lookups that fall through to downloads). */
  const tasks = (): TaskQueue | undefined => {
    const tk = toolkitOf(deps.manager?.downloader);
    if (!tk || !deps.manager) return undefined;
    const manager = deps.manager;
    // Tasks live as long as the download manager: its close() (server shutdown) also cancels and removes them.
    if (!closeHooked.has(manager)) {
      closeHooked.add(manager);
      const close = manager.close.bind(manager);
      manager.close = async () => {
        await Promise.all([close(), tk.jobs.close()]);
      };
    }
    return tk.jobs;
  };

  app.get('/downloads/toolkit', (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const policy = downloadPolicy(ctx.env);
    const limits = toolkitLimits(ctx.env);
    const available = policy.enabled && !!toolkitOf(deps.manager?.downloader);
    return c.json({
      enabled: available,
      ...(!policy.enabled && policy.reason ? { reason: policy.reason } : {}),
      captions: {
        formats: captionFormatList(),
        modes: CAPTION_MODES,
        via: CAPTION_VIA,
        defaults: { format: 'srt', mode: 'auto', via: 'auto', allowAuto: true, allowTranslated: true },
        maxTracks: limits.maxCaptionTracks,
        // Options of POST /downloads/captions beyond the format: offsetSec (any number), the cue layout, and secondary (a language).
        layout: { maxLineChars: LINE_CHARS_RANGE, maxLines: LINES_RANGE },
      },
      frames: { formats: FRAME_FORMATS, defaults: { format: 'png', quality: '1080' }, maxFrames: limits.maxFrames },
      clips: {
        formats: ANIMATION_FORMATS,
        defaults: {
          format: 'gif',
          fps: Math.min(DEFAULT_CLIP_FPS, limits.maxClipFps),
          width: Math.min(DEFAULT_CLIP_WIDTH, limits.maxClipWidth),
          lengthSec: Math.min(5, limits.maxClipSec),
        },
        maxSec: limits.maxClipSec,
        maxWidth: limits.maxClipWidth,
        maxFps: limits.maxClipFps,
      },
      batch: { kinds: ['video', 'audio', 'captions'], maxItems: limits.maxBatchItems },
      watchdog: { stallSec: limits.stallSec, stallRetries: limits.stallRetries, minFreeMb: limits.minFreeMb },
    });
  });

  app.get('/downloads/captions/tracks', async (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const tk = toolkit(ctx);
    const url = (c.req.query('url') ?? c.req.query('input'))?.trim();
    if (!url)
      throw new Vid2ContextError('bad-request', 'Missing the url query parameter.', { hint: 'Pass ?url=<video URL or id>.' });
    await enforceInputPolicy(url, ctx);
    return c.json(await tk.captionTracks(url, ctx));
  });

  const start = (kind: ToolkitKind) => async (c: Context) => {
    const ctx = deps.makeCtx(c.req.raw);
    const tk = toolkit(ctx);
    const body = await readBody(c);
    const req = normalizeToolkitRequest(body, kind, ctx.env);
    const inputs = req.kind === 'batch' ? req.inputs : [req.input];
    for (const input of inputs) {
      await enforceInputPolicy(input, ctx);
      // A batch takes playlists and channels; a single task needs one video that exists.
      await tk.check(input, ctx, { single: req.kind !== 'batch' });
    }
    const job = (tasks() as TaskQueue).create(req, ctx);
    const base = new URL(c.req.url).pathname.replace(/\/(captions|frames|clips|batch)\/?$/, '');
    return c.json(job, 202, { location: `${base}/${job.id}` });
  };
  app.post('/downloads/captions', start('captions'));
  app.post('/downloads/frames', start('frames'));
  app.post('/downloads/clips', start('animation'));
  app.post('/downloads/batch', start('batch'));

  // Before POST /downloads queues a job: a bad or missing video answers 400 or 404 now, not as a failed job.
  // Invalid bodies are left to the download route, which explains them.
  app.post('/downloads', async (c, next) => {
    const ctx = deps.makeCtx(c.req.raw);
    const tk = toolkitOf(deps.manager?.downloader);
    if (!tk || !downloadPolicy(ctx.env).enabled) return next();
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const input = typeof body?.url === 'string' ? body.url.trim() : typeof body?.input === 'string' ? body.input.trim() : '';
    if (input) {
      await enforceInputPolicy(input, ctx);
      await tk.check(input, ctx, { single: true });
    }
    return next();
  });

  // The list: download jobs from the routes after this one, plus toolkit tasks.
  app.get('/downloads', async (c, next) => {
    await next();
    const q = tasks();
    if (!q || c.res.status !== 200) return;
    const body = (await c.res.clone().json()) as { jobs?: { createdAt: string }[] };
    const jobs = [...(body.jobs ?? []), ...q.list()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    c.res = new Response(JSON.stringify({ ...body, jobs }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=UTF-8' },
    });
  });

  app.get('/downloads/:id', async (c, next) => {
    const job = tasks()?.get(c.req.param('id'));
    if (!job) return next();
    toolkit(deps.makeCtx(c.req.raw));
    return c.json(job);
  });

  const serve = async (c: Context, q: TaskQueue, id: string, item?: number) => {
    const job = q.get(id);
    if (!job) throw new Vid2ContextError('not-found', `No task with id ${id.slice(0, 64)}.`, { hint: 'Start it again.' });
    if (job.status !== 'done') {
      throw new Vid2ContextError('bad-request', `The task is ${job.status}, not done.`, {
        hint: job.status === 'error' ? (job.error?.hint ?? 'Start it again.') : 'Poll GET /downloads/:id until status is done.',
      });
    }
    if (item !== undefined) {
      const it = job.items?.[item];
      if (!it)
        throw new Vid2ContextError('not-found', `No item ${item} in this batch.`, {
          hint: `Items go from 0 to ${(job.items?.length ?? 1) - 1}.`,
        });
      if (it.status !== 'done') {
        throw new Vid2ContextError('bad-request', `Item ${item} is ${it.status}.`, {
          hint: it.error?.hint ?? it.error?.message ?? 'Pick a done item.',
        });
      }
    }
    const whole: JobFile | undefined = await q.open(id, undefined, item);
    if (!whole) {
      throw new Vid2ContextError('not-found', 'The file is gone (expired or deleted).', {
        hint:
          job.file || item !== undefined
            ? 'Start the task again.'
            : 'This batch was saved without zip: fetch each item at /downloads/:id/items/:n/file.',
      });
    }
    const inline = ['1', 'true', 'yes'].includes(c.req.query('inline') ?? '');
    const headers: Record<string, string> = {
      'content-type': whole.mimeType,
      'content-disposition': contentDisposition(whole.filename, inline),
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    };
    const range = parseRange(c.req.header('range'), whole.bytes);
    if (range === 'invalid') {
      await whole.stream.cancel();
      return c.body(null, 416, { ...headers, 'content-range': `bytes */${whole.bytes}` });
    }
    if (range) {
      await whole.stream.cancel();
      const slice = await q.open(id, range, item);
      if (!slice)
        throw new Vid2ContextError('not-found', 'The file is gone (expired or deleted).', { hint: 'Start the task again.' });
      return c.body(slice.stream, 206, {
        ...headers,
        'content-range': `bytes ${range.start}-${range.end}/${whole.bytes}`,
        'content-length': String(range.end - range.start + 1),
      });
    }
    return c.body(whole.stream, 200, { ...headers, 'content-length': String(whole.bytes) });
  };

  app.get('/downloads/:id/file', async (c, next) => {
    const q = tasks();
    const id = c.req.param('id');
    if (!q?.get(id)) return next();
    toolkit(deps.makeCtx(c.req.raw));
    return serve(c, q, id);
  });

  app.get('/downloads/:id/items/:n/file', async (c) => {
    toolkit(deps.makeCtx(c.req.raw));
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n) || n < 0) {
      throw new Vid2ContextError('bad-request', 'The item number must be 0 or more.', {
        hint: 'Use /downloads/:id/items/0/file.',
      });
    }
    return serve(c, tasks() as TaskQueue, c.req.param('id'), n);
  });

  app.delete('/downloads/:id', async (c, next) => {
    const q = tasks();
    const id = c.req.param('id');
    if (!q?.get(id)) return next();
    toolkit(deps.makeCtx(c.req.raw));
    await q.remove(id);
    return c.json({ deleted: true, id });
  });

  return app;
}
