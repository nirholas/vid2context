/**
 * Uploaded media, held in this process's memory for a limited time. An upload
 * is addressed by the SHA-256 of its bytes (`upload:<sha256>`), so uploading
 * the same file twice reuses one entry. The server resolves these inputs
 * itself (they never reach the registry) and transcribes them with the core
 * speech-to-text chain. Transcripts of uploads are kept next to the upload,
 * never in the library, and expire with it.
 */
import { type AudioInput, Vid2ContextError, type VideoContext, type VideoMetadata, type VideoRef } from '@vid2context/core';

export const UPLOAD_PREFIX = 'upload:';
const UPLOAD_ID = /^upload:([0-9a-f]{64})$/;

export interface UploadEntry {
  sha256: string;
  filename: string;
  mimeType: string;
  data: Uint8Array;
  createdAt: number;
  expiresAt: number;
  /** Transcribed contexts by requested language ('' for auto-detect). */
  contexts: Map<string, VideoContext>;
}

/** True for inputs of the form `upload:<64 hex>` (and anything else starting with `upload:`, so typos get a clear error). */
export function isUploadInput(input: string): boolean {
  return input.trim().toLowerCase().startsWith(UPLOAD_PREFIX);
}

/** Extensions to MIME types for the audio and video files speech-to-text services accept. */
const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  mpga: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  weba: 'audio/webm',
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
};

export function guessMimeType(filename: string, declared: string | undefined): string {
  const d = declared?.split(';')[0]?.trim().toLowerCase();
  if (d && d !== 'application/octet-stream') return d;
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Keep the base name only, without control or path characters, at most 200 characters. */
export function cleanFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (cleaned || 'upload').slice(-200);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class UploadStore {
  private entries = new Map<string, UploadEntry>();

  private sweep(now: number): void {
    for (const [id, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(id);
  }

  private totalBytes(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.data.byteLength;
    return n;
  }

  /**
   * Store an upload. `maxTotalBytes` caps what all live uploads may hold
   * together: the oldest are dropped first when this one would exceed it.
   */
  async put(
    data: Uint8Array,
    filename: string,
    mimeType: string,
    opts: { ttlMs: number; maxTotalBytes: number; now?: number },
  ): Promise<UploadEntry> {
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs;
    this.sweep(now);
    const sha256 = await sha256Hex(data);
    const existing = this.entries.get(sha256);
    if (existing) {
      existing.expiresAt = now + ttlMs;
      return existing;
    }
    const cap = opts.maxTotalBytes;
    const oldest = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
    while (oldest.length > 0 && this.totalBytes() + data.byteLength > cap) {
      const drop = oldest.shift();
      if (drop) this.entries.delete(drop.sha256);
    }
    const entry: UploadEntry = { sha256, filename, mimeType, data, createdAt: now, expiresAt: now + ttlMs, contexts: new Map() };
    this.entries.set(sha256, entry);
    return entry;
  }

  /** The live upload for an `upload:<sha256>` input. Throws `bad-request` for a malformed id and `not-found` when it expired or never existed. */
  get(input: string, ttlMin: number, now = Date.now()): UploadEntry {
    const m = UPLOAD_ID.exec(input.trim().toLowerCase());
    if (!m) {
      throw new Vid2ContextError('bad-request', `"${input.slice(0, 80)}" is not a valid upload id.`, {
        hint: 'Upload ids look like upload:<64 hex characters>, as returned by POST /api/v1/uploads.',
      });
    }
    this.sweep(now);
    const entry = this.entries.get(m[1] as string);
    if (!entry) {
      throw new Vid2ContextError('not-found', `No upload ${input.slice(0, 80)} on this server.`, {
        hint: `Uploads are kept in memory for ${ttlMin} minutes and are lost on restart. Upload the file again with POST /api/v1/uploads.`,
      });
    }
    return entry;
  }
}

export function uploadRef(entry: UploadEntry): VideoRef {
  const input = `${UPLOAD_PREFIX}${entry.sha256}`;
  return { input, platform: 'upload', kind: 'video', id: input, nativeId: entry.sha256 };
}

/** Minimal metadata from the file name: the title is the name without its extension. */
export function uploadMetadata(entry: UploadEntry): VideoMetadata {
  return {
    ref: uploadRef(entry),
    title: entry.filename.replace(/\.[a-z0-9]{1,5}$/i, '') || entry.filename,
    chapters: [],
    extra: { filename: entry.filename, bytes: entry.data.byteLength, mimeType: entry.mimeType },
  };
}

export function uploadAudio(entry: UploadEntry): AudioInput {
  return { kind: 'bytes', data: entry.data, mimeType: entry.mimeType, filename: entry.filename };
}
