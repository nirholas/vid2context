/**
 * HTTP routes for downloads, relative to /api/v1. The server mounts them with
 * `app.route('/api/v1', downloadsRoutes({ makeCtx, manager }))`; the Node
 * entry passes a manager from `createDownloadManager`, Workers pass none (no
 * yt-dlp or ffmpeg there) and every route except /downloads/status answers
 * `no-provider`. Errors propagate to the main app's onError.
 *
 *   GET    /downloads/status        enabled?, limits, formats, qualities
 *   GET    /downloads/options?url=  qualities and estimated sizes for one video
 *   POST   /downloads               start a download, 202 with the job
 *   GET    /downloads               jobs on this server, newest first
 *   GET    /downloads/:id           one job with its progress
 *   GET    /downloads/:id/file      the finished file (Range supported; ?inline=1 to play it)
 *   DELETE /downloads/:id           cancel, or delete the finished file
 */
import { type Ctx, enforceInputPolicy, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import {
  AUDIO_FORMATS,
  AUDIO_QUALITIES,
  FORMAT_LABELS,
  normalizeRequest,
  type RawDownloadRequest,
  SPONSOR_CATEGORIES,
  VIDEO_CONTAINERS,
  VIDEO_QUALITIES,
} from './options.ts';
import { downloadPolicy, NOTICE } from './policy.ts';
import type { DownloadManager } from './types.ts';

export interface DownloadsRouteDeps {
  makeCtx: (req: Request) => Ctx;
  /** Server-side download queue (Node). Leave out on runtimes that cannot run yt-dlp and ffmpeg. */
  manager?: DownloadManager;
}

function unavailable(reason: string): Vid2ContextError {
  return new Vid2ContextError('no-provider', reason, {
    hint: 'Run vid2context on your own machine (npx vid2context download <url>) or on a Node server with downloads enabled.',
  });
}

/** `attachment; filename="..."; filename*=UTF-8''...` with an ASCII fallback for old clients. */
export function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Parse a single `bytes=` range against a size. Returns null when absent, 'invalid' when unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export function downloadsRoutes(deps: DownloadsRouteDeps): Hono {
  const app = new Hono();

  /** The manager when downloads are allowed here, else an error saying why not. */
  const ready = (ctx: Ctx): DownloadManager => {
    const policy = downloadPolicy(ctx.env);
    if (!policy.enabled) {
      // `unavailable` renders as 403: the feature exists but this deployment does not offer it.
      throw new Vid2ContextError('unavailable', policy.reason ?? 'Downloads are off.', {
        hint: 'Set VID2CONTEXT_DOWNLOADS=1 on the server, or run vid2context locally.',
      });
    }
    if (!deps.manager) throw unavailable(`Downloads need yt-dlp and ffmpeg, which this ${ctx.runtime} runtime cannot run.`);
    return deps.manager;
  };

  app.get('/downloads/status', async (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const policy = downloadPolicy(ctx.env);
    const available = policy.enabled && !!deps.manager;
    const tools = available && deps.manager ? await deps.manager.downloader.status(ctx) : undefined;
    return c.json({
      enabled: available && (tools?.ready ?? false),
      ...(policy.reason
        ? { reason: policy.reason }
        : !deps.manager
          ? { reason: `Downloads need yt-dlp and ffmpeg, which this ${ctx.runtime} runtime cannot run.` }
          : tools && !tools.ready && tools.problem
            ? { reason: tools.problem }
            : {}),
      notice: NOTICE,
      limits: { maxBytes: policy.maxBytes, maxDurationSec: policy.maxDurationSec, ttlMin: policy.ttlMin },
      formats: {
        video: VIDEO_CONTAINERS.map((id) => ({ id, label: FORMAT_LABELS[id] })),
        audio: AUDIO_FORMATS.map((id) => ({ id, label: FORMAT_LABELS[id] })),
      },
      qualities: { video: VIDEO_QUALITIES, audio: AUDIO_QUALITIES },
      sponsorCategories: SPONSOR_CATEGORIES,
      ...(tools?.ytdlp ? { ytdlp: tools.ytdlp.version } : {}),
    });
  });

  app.get('/downloads/options', async (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const manager = ready(ctx);
    const url = c.req.query('url')?.trim();
    if (!url)
      throw new Vid2ContextError('bad-request', 'Missing the url query parameter.', { hint: 'Pass ?url=<video URL or id>.' });
    await enforceInputPolicy(url, ctx);
    return c.json(await manager.downloader.probe(url, ctx));
  });

  app.post('/downloads', async (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const manager = ready(ctx);
    let body: RawDownloadRequest;
    try {
      body = (await c.req.json()) as RawDownloadRequest;
    } catch {
      throw new Vid2ContextError('bad-request', 'The body must be JSON.', {
        hint: 'Send {"url": "...", "kind": "video" | "audio", "format": "mp4", "quality": "1080"}.',
      });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Vid2ContextError('bad-request', 'The body must be a JSON object.', { hint: 'Send {"url": "..."}.' });
    }
    const req = normalizeRequest(body);
    await enforceInputPolicy(req.input, ctx);
    const job = manager.create(req, ctx);
    return c.json(job, 202, { location: `${new URL(c.req.url).pathname.replace(/\/+$/, '')}/${job.id}` });
  });

  app.get('/downloads', (c) => {
    const manager = ready(deps.makeCtx(c.req.raw));
    return c.json({ jobs: manager.list() });
  });

  const jobOr404 = (manager: DownloadManager, id: string) => {
    const job = manager.get(id);
    if (!job) {
      throw new Vid2ContextError('not-found', `No download with id ${id.slice(0, 64)}.`, {
        hint: 'Finished files expire after VID2CONTEXT_DOWNLOAD_TTL_MIN minutes, and jobs end when the server restarts. Start it again.',
      });
    }
    return job;
  };

  app.get('/downloads/:id', (c) => {
    const manager = ready(deps.makeCtx(c.req.raw));
    return c.json(jobOr404(manager, c.req.param('id')));
  });

  app.get('/downloads/:id/file', async (c) => {
    const manager = ready(deps.makeCtx(c.req.raw));
    const id = c.req.param('id');
    const job = jobOr404(manager, id);
    if (job.status !== 'done') {
      throw new Vid2ContextError('bad-request', `The download is ${job.status}, not done.`, {
        hint: job.status === 'error' ? (job.error?.hint ?? 'Start it again.') : 'Poll GET /downloads/:id until status is done.',
      });
    }
    const whole = await manager.open(id);
    if (!whole)
      throw new Vid2ContextError('not-found', 'The file is gone (expired or deleted).', { hint: 'Start the download again.' });
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
      const part = await manager.open(id, range);
      if (!part)
        throw new Vid2ContextError('not-found', 'The file is gone (expired or deleted).', { hint: 'Start the download again.' });
      return c.body(part.stream, 206, {
        ...headers,
        'content-range': `bytes ${range.start}-${range.end}/${whole.bytes}`,
        'content-length': String(range.end - range.start + 1),
      });
    }
    return c.body(whole.stream, 200, { ...headers, 'content-length': String(whole.bytes) });
  });

  app.delete('/downloads/:id', async (c) => {
    const manager = ready(deps.makeCtx(c.req.raw));
    const id = c.req.param('id');
    if (!(await manager.remove(id))) jobOr404(manager, id);
    return c.json({ deleted: true, id });
  });

  return app;
}
