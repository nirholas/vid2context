/**
 * POST /uploads: multipart form with a `file` field. The file is held in
 * memory for VID2CONTEXT_UPLOAD_TTL_MIN minutes under `upload:<sha256>`, which
 * any route taking a `url` (and POST /pack, POST /bundle) accepts while it
 * lives. Large video files should be reduced to audio in the browser first
 * (the web app does this), both for the size cap and for speech-to-text
 * upload limits.
 */
import { Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { badRequest } from '../errors.ts';
import { json, ref } from '../openapi.ts';
import type { AppEnv, RouteDeps } from '../types.ts';
import { cleanFilename, guessMimeType, UPLOAD_PREFIX } from '../uploads.ts';

/** How many uploads at the size cap may be held at once; older ones are dropped first. */
const UPLOADS_HELD_AT_CAP = 4;

export function tooLarge(maxMb: number): Vid2ContextError {
  return new Vid2ContextError('too-large', `The upload is larger than ${maxMb} MB.`, {
    hint: 'Reduce the file to compressed audio first (for example 64 kbit/s mono MP3 or Opus: about 30 MB per hour). The web app does this in the browser.',
  });
}

export function uploadRoutes({ services, docs }: RouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  docs.add({
    method: 'post',
    path: '/api/v1/uploads',
    summary: 'Upload an audio or video file; returns an input (upload:<sha256>) for the other routes.',
    description:
      'Size cap VID2CONTEXT_MAX_UPLOAD_MB (default 100). Held in memory for VID2CONTEXT_UPLOAD_TTL_MIN minutes (default 60) and never saved to the library. Reduce large videos to audio before uploading.',
    tags: ['uploads'],
    body: {
      content: {
        'multipart/form-data': { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] },
      },
    },
    responses: { '201': { description: 'Stored.', content: json(ref('Upload')) } },
  });
  app.post('/uploads', async (c) => {
    const cfg = services.config(c.req.raw);
    const type = c.req.header('content-type') ?? '';
    if (!type.toLowerCase().startsWith('multipart/form-data')) {
      throw badRequest('Uploads must be multipart/form-data.', 'Send the file in a form field named "file" (curl -F file=@talk.mp3).');
    }
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch (err) {
      if (err instanceof Vid2ContextError) throw err;
      throw badRequest('Could not read the multipart body.', 'Send the file in a form field named "file" (curl -F file=@talk.mp3).');
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      throw badRequest('Missing the "file" field.', 'Send the file in a form field named "file" (curl -F file=@talk.mp3).');
    }
    if (file.size > cfg.maxUploadBytes) throw tooLarge(cfg.maxUploadMb);
    if (file.size === 0) throw badRequest('The uploaded file is empty.', 'Pick a non-empty audio or video file.');
    const filename = cleanFilename(file.name || 'upload');
    const mimeType = guessMimeType(filename, file.type);
    const entry = await services.uploads.put(new Uint8Array(await file.arrayBuffer()), filename, mimeType, {
      ttlMs: cfg.uploadTtlMin * 60_000,
      maxTotalBytes: UPLOADS_HELD_AT_CAP * cfg.maxUploadBytes,
    });
    return c.json(
      {
        input: `${UPLOAD_PREFIX}${entry.sha256}`,
        filename: entry.filename,
        bytes: entry.data.byteLength,
        mimeType: entry.mimeType,
        expiresAt: new Date(entry.expiresAt).toISOString(),
      },
      201,
    );
  });

  return app;
}
