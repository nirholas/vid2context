/**
 * The web side of the extension bridge (docs/contracts/transcript-import.md,
 * "Extension bridge"). The vid2context extension's content script runs on
 * this page and relays requests to the extension, which fetches YouTube
 * captions from the user's own IP address. Messages go through
 * window.postMessage on this window only:
 *
 *   web -> extension   { source: 'vid2context-web', type: 'ping' | 'youtube-transcript', id, ... }
 *   extension -> web   { source: 'vid2context-extension', type: 'pong' | 'progress' | 'youtube-transcript:result', ... }
 *
 * Only messages from this window, this origin and with the extension's
 * source tag are read; anything else is ignored.
 */
import { type ErrorCode, Vid2ContextError } from '@vid2context/core';

export const WEB_SOURCE = 'vid2context-web';
export const EXTENSION_SOURCE = 'vid2context-extension';
/** No pong within this long after a ping: the extension is not installed (or not enabled on this site). */
export const PING_TIMEOUT_MS = 800;
/** The extension may open a background YouTube tab; give up after this long. */
export const REQUEST_TIMEOUT_MS = 90_000;
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface ExtensionInfo {
  version: string;
  capabilities: string[];
}

export interface BridgeTranscript {
  language: string;
  kind: 'creator-captions' | 'auto-captions';
  name?: string;
  translated?: boolean;
  segments: { startSec: number; endSec: number; text: string }[];
}

export interface BridgeMetadata {
  title?: string;
  channel?: string;
  durationSec?: number;
}

export interface BridgeResult {
  transcript: BridgeTranscript;
  metadata?: BridgeMetadata;
}

export interface BridgeProgress {
  stage: 'player' | 'captions' | 'tab';
  message: string;
}

type Incoming = Record<string, unknown> & { source: typeof EXTENSION_SOURCE; type: string };

/** The message data when it is the extension talking to this window, else null. */
export function extensionMessage(event: MessageEvent, win: Window = window): Incoming | null {
  if (event.source !== win || event.origin !== win.location.origin) return null;
  const d = event.data as unknown;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const m = d as Record<string, unknown>;
  if (m.source !== EXTENSION_SOURCE || typeof m.type !== 'string') return null;
  return m as Incoming;
}

function newId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function post(win: Window, msg: Record<string, unknown>): void {
  win.postMessage({ source: WEB_SOURCE, ...msg }, win.location.origin);
}

/**
 * Ping the extension. Resolves with its version and capabilities, or null
 * when no pong arrives within PING_TIMEOUT_MS. The pong the content script
 * sends unprompted when it loads counts too.
 */
export function detectExtension(opts: { timeoutMs?: number; win?: Window } = {}): Promise<ExtensionInfo | null> {
  const win = opts.win ?? window;
  const id = newId();
  return new Promise((resolve) => {
    const done = (info: ExtensionInfo | null) => {
      win.removeEventListener('message', on);
      clearTimeout(timer);
      resolve(info);
    };
    const on = (event: MessageEvent) => {
      const m = extensionMessage(event, win);
      if (m?.type !== 'pong' || (m.id !== undefined && m.id !== id)) return;
      done({
        version: typeof m.version === 'string' ? m.version : '',
        capabilities: Array.isArray(m.capabilities) ? m.capabilities.filter((c): c is string => typeof c === 'string') : [],
      });
    };
    win.addEventListener('message', on);
    const timer = setTimeout(() => done(null), opts.timeoutMs ?? PING_TIMEOUT_MS);
    post(win, { type: 'ping', id });
  });
}

const CODES: Record<string, ErrorCode> = {
  'bad-request': 'bad-request',
  'not-found': 'not-found',
  unavailable: 'unavailable',
  'no-captions': 'no-transcript',
  blocked: 'blocked',
  timeout: 'timeout',
};

const DEFAULT_HINTS: Record<string, string> = {
  'no-captions': 'This video has no captions YouTube can give. Paste a transcript or upload a subtitle file instead.',
  blocked:
    'YouTube refused this browser too. Open the video on youtube.com once (sign in if it asks), then try again, or paste the transcript.',
  timeout: 'Try again, or paste the transcript from the video page.',
};

function bridgeError(raw: unknown): Vid2ContextError {
  const e = (raw && typeof raw === 'object' ? raw : {}) as { code?: unknown; message?: unknown; hint?: unknown };
  const code = typeof e.code === 'string' ? e.code : 'unavailable';
  return new Vid2ContextError(
    CODES[code] ?? 'upstream',
    typeof e.message === 'string' && e.message ? e.message : 'The vid2context extension could not get the transcript.',
    {
      hint:
        typeof e.hint === 'string' && e.hint ? e.hint : (DEFAULT_HINTS[code] ?? 'Try again, or paste the transcript instead.'),
    },
  );
}

function validSegments(v: unknown): v is BridgeTranscript['segments'] {
  return (
    Array.isArray(v) &&
    v.every(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof (s as { startSec?: unknown }).startSec === 'number' &&
        typeof (s as { endSec?: unknown }).endSec === 'number' &&
        typeof (s as { text?: unknown }).text === 'string',
    )
  );
}

function metadataOf(v: unknown): BridgeMetadata | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  const out: BridgeMetadata = {};
  if (typeof m.title === 'string' && m.title.trim()) out.title = m.title.trim();
  if (typeof m.channel === 'string' && m.channel.trim()) out.channel = m.channel.trim();
  if (typeof m.durationSec === 'number' && Number.isFinite(m.durationSec) && m.durationSec > 0) out.durationSec = m.durationSec;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Ask the extension for a YouTube video's transcript. Call it from a click
 * handler. Rejects with a Vid2ContextError (the extension's code, `timeout`
 * after REQUEST_TIMEOUT_MS) or an AbortError when `signal` aborts.
 */
export function requestYouTubeTranscript(
  videoId: string,
  opts: {
    language?: string;
    onProgress?: (p: BridgeProgress) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
    win?: Window;
  } = {},
): Promise<BridgeResult> {
  const win = opts.win ?? window;
  if (!VIDEO_ID_RE.test(videoId)) {
    return Promise.reject(
      new Vid2ContextError('bad-request', `"${videoId}" is not a YouTube video id.`, {
        hint: 'Open a YouTube watch link (youtube.com/watch?v=...) and try again.',
      }),
    );
  }
  const id = newId();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      win.removeEventListener('message', on);
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Canceled', 'AbortError'));
    };
    const on = (event: MessageEvent) => {
      const m = extensionMessage(event, win);
      if (!m || m.id !== id) return;
      if (m.type === 'progress') {
        if (typeof m.message === 'string') opts.onProgress?.({ stage: m.stage as BridgeProgress['stage'], message: m.message });
        return;
      }
      if (m.type !== 'youtube-transcript:result') return;
      cleanup();
      if (m.ok !== true) {
        reject(bridgeError(m.error));
        return;
      }
      const t = m.transcript as Partial<BridgeTranscript> | undefined;
      if (!t || typeof t.language !== 'string' || !validSegments(t.segments)) {
        reject(
          new Vid2ContextError('upstream', 'The vid2context extension sent a transcript this page cannot read.', {
            hint: 'Update the extension and reload this page, or paste the transcript instead.',
          }),
        );
        return;
      }
      resolve({
        transcript: {
          language: t.language,
          kind: t.kind === 'auto-captions' ? 'auto-captions' : 'creator-captions',
          ...(typeof t.name === 'string' ? { name: t.name } : {}),
          ...(t.translated === true ? { translated: true } : {}),
          segments: t.segments,
        },
        metadata: metadataOf(m.metadata),
      });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Vid2ContextError('timeout', 'The vid2context extension did not answer within 90 seconds.', {
          hint: 'Try again, or paste the transcript from the video page.',
        }),
      );
    }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    win.addEventListener('message', on);
    post(win, { type: 'youtube-transcript', id, videoId, ...(opts.language ? { language: opts.language } : {}) });
  });
}
