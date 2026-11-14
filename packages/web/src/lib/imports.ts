/**
 * Transcript import from the web app (docs/contracts/transcript-import.md):
 * POST /imports when an API is reachable, otherwise the same
 * importTranscript from @vid2context/imports, run here in the browser.
 */
import { Vid2ContextError, type VideoContext } from '@vid2context/core';
import type { ImportRequest, ImportResponse, KnownMetadata } from '@vid2context/imports';
import { matchYouTube } from '@vid2context/provider-youtube';
import { apiBase, type CallOptions, unreachable } from './api.ts';
import { fromApiBody, isAbort, isApiErrorBody } from './errors.ts';

export type { ImportRequest, ImportResponse, KnownMetadata };

/** The YouTube video id of a link, or null when it is not a single YouTube video. */
export function youtubeVideoId(input: string): string | null {
  const ref = matchYouTube(input.trim());
  return ref && ref.kind === 'video' ? ref.nativeId : null;
}

/** Errors where the transcript can still come from the user: YouTube blocked the server, or had no captions for it. */
const IMPORTABLE = new Set(['blocked', 'no-transcript', 'upstream', 'rate-limited', 'all-rungs-failed']);

export function canImportAfter(input: string, error: unknown): boolean {
  return youtubeVideoId(input) !== null && error instanceof Vid2ContextError && IMPORTABLE.has(error.code);
}

/** POST /imports. Throws an AppError with the server's code and hint. */
export async function postImport(body: ImportRequest, call: CallOptions = {}): Promise<ImportResponse> {
  const base = call.base ?? apiBase();
  const doFetch = call.fetch ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await doFetch(`${base}/imports`, {
      method: 'POST',
      signal: call.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw unreachable(base, err);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Vid2ContextError('upstream', `${base}/imports answered with HTTP ${res.status} but not with vid2context JSON.`, {
      hint: 'The API base probably points at a static site, or at a server too old to import transcripts. Update the server.',
      status: res.status,
    });
  }
  if (!res.ok) {
    if (isApiErrorBody(json)) throw fromApiBody(json, res.status);
    throw new Vid2ContextError('upstream', `${base}/imports answered with HTTP ${res.status}.`, {
      hint: 'Check the server log (stderr) for the details.',
      status: res.status,
    });
  }
  return json as ImportResponse;
}

/**
 * Client-only mode: build the context here. The browser cannot reach
 * YouTube's metadata (CORS), so metadata comes from the extension's result
 * or is minimal (the link as the title). Nothing is saved on a server.
 */
export async function importInBrowser(body: ImportRequest, metadata?: KnownMetadata): Promise<ImportResponse> {
  const [{ importTranscript }, { createBrowserContext, createRegistry }] = await Promise.all([
    import('@vid2context/imports'),
    import('@vid2context/registry/browser'),
  ]);
  return importTranscript(
    createRegistry(),
    body,
    { fetchMetadata: false, ...(metadata ? { metadata } : {}) },
    createBrowserContext({}),
  );
}

/** Import through the API when there is one, else in the browser. */
export function runImport(
  body: ImportRequest,
  opts: { clientOnly: boolean; metadata?: KnownMetadata; signal?: AbortSignal },
): Promise<ImportResponse> {
  return opts.clientOnly
    ? importInBrowser(body, opts.metadata)
    : postImport({ ...body, ...(opts.metadata ? { metadata: opts.metadata } : {}) }, { signal: opts.signal });
}

/** True when the import used only the link as the title (the server or the browser could not read the video's metadata). */
export function hasMinimalMetadata(context: VideoContext): boolean {
  const m = context.metadata;
  return m.title === (m.ref.url ?? m.ref.input);
}
