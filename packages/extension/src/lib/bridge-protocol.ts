/**
 * The web app to extension bridge (docs/contracts/transcript-import.md,
 * "Extension bridge"). The web app and `bridge.js` talk with
 * window.postMessage on the web app's page; `bridge.js` and the background
 * talk over a runtime Port named BRIDGE_PORT.
 *
 * Everything that arrives from the page is untrusted: `parseWebMessage`
 * accepts only the shapes the contract lists and ignores the rest.
 */

export const WEB_SOURCE = 'vid2context-web';
export const EXTENSION_SOURCE = 'vid2context-extension';
export const CAPABILITIES = ['youtube-transcript'] as const;
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** BCP 47 shaped: a 2 or 3 letter primary subtag, then subtags of 1 to 8 letters or digits. */
export const LANGUAGE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const MAX_ID_LENGTH = 200;

/** Port name for bridge.js <-> background. */
export const BRIDGE_PORT = 'v2c-bridge';

export type BridgeErrorCode = 'bad-request' | 'not-found' | 'unavailable' | 'no-captions' | 'blocked' | 'timeout';
export type ProgressStage = 'player' | 'captions' | 'tab';

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
  hint?: string;
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

/** The body of a result, without the envelope fields. */
export type ResultBody =
  | { ok: true; transcript: BridgeTranscript; metadata?: BridgeMetadata }
  | { ok: false; error: BridgeError };

export interface TranscriptRequest {
  videoId: string;
  language?: string;
}

// ---------------------------------------------------------------- web <-> bridge.js

export interface PongMessage {
  source: typeof EXTENSION_SOURCE;
  type: 'pong';
  id?: string;
  version: string;
  capabilities: string[];
}

export interface ProgressMessage {
  source: typeof EXTENSION_SOURCE;
  type: 'progress';
  id: string;
  stage: ProgressStage;
  message: string;
}

export type ResultMessage = { source: typeof EXTENSION_SOURCE; type: 'youtube-transcript:result'; id: string } & ResultBody;

export type ExtensionMessage = PongMessage | ProgressMessage | ResultMessage;

/** What a page message turned out to be. `null` means: not for us, ignore it silently. */
export type WebMessage =
  | { kind: 'ping'; id: string }
  | { kind: 'transcript'; id: string; request: TranscriptRequest }
  /** A transcript request with a usable id but invalid fields: answer with this error. */
  | { kind: 'invalid'; id: string; error: BridgeError };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function validId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;
}

/**
 * The event's data when it came from this very window and origin, else null.
 * Content scripts and the page share `window`, so other frames and other
 * origins are the only senders this rules out; the `source` field check in
 * parseWebMessage rules out our own outgoing messages.
 */
export function eventData(
  event: { source: unknown; origin: string; data: unknown },
  self: { window: unknown; origin: string },
): unknown {
  if (event.source !== self.window || event.origin !== self.origin) return null;
  return event.data;
}

export function parseWebMessage(data: unknown): WebMessage | null {
  if (!isPlainObject(data) || data.source !== WEB_SOURCE) return null;
  if (data.type === 'ping') return validId(data.id) ? { kind: 'ping', id: data.id } : null;
  if (data.type !== 'youtube-transcript' || !validId(data.id)) return null;
  const id = data.id;
  const bad = (message: string, hint: string): WebMessage => ({
    kind: 'invalid',
    id,
    error: { code: 'bad-request', message, hint },
  });
  if (typeof data.videoId !== 'string' || !VIDEO_ID_RE.test(data.videoId)) {
    return bad('videoId must be an 11 character YouTube video id.', 'Send the id from the watch URL, for example jNQXAC9IVRw.');
  }
  if (data.language !== undefined && (typeof data.language !== 'string' || !LANGUAGE_RE.test(data.language))) {
    return bad('language must be a BCP 47 code such as en or pt-BR.', 'Leave language out to get the spoken language.');
  }
  const request: TranscriptRequest = { videoId: data.videoId };
  if (typeof data.language === 'string') request.language = data.language;
  return { kind: 'transcript', id, request };
}

export function pongMessage(version: string, id?: string): PongMessage {
  return { source: EXTENSION_SOURCE, type: 'pong', ...(id ? { id } : {}), version, capabilities: [...CAPABILITIES] };
}

export function progressMessage(id: string, stage: ProgressStage, message: string): ProgressMessage {
  return { source: EXTENSION_SOURCE, type: 'progress', id, stage, message };
}

export function resultMessage(id: string, body: ResultBody): ResultMessage {
  return { source: EXTENSION_SOURCE, type: 'youtube-transcript:result', id, ...body };
}

// ---------------------------------------------------------------- bridge.js <-> background (Port)

export interface PortRequest {
  type: 'youtube-transcript';
  videoId: string;
  language?: string;
}

export type PortReply = { type: 'progress'; stage: ProgressStage; message: string } | { type: 'result'; body: ResultBody };

/** The background re-checks what bridge.js forwards, with the same rules. */
export function parsePortRequest(raw: unknown): TranscriptRequest | BridgeError {
  const msg = parseWebMessage(isPlainObject(raw) ? { ...raw, source: WEB_SOURCE, type: raw.type, id: 'port' } : null);
  if (msg?.kind === 'transcript') return msg.request;
  if (msg?.kind === 'invalid') return msg.error;
  return { code: 'bad-request', message: 'Unknown request.', hint: 'Send a youtube-transcript request.' };
}
