/**
 * Uploaded media, kept for a limited time and addressed by the SHA-256 of its
 * bytes (`upload:<sha256>`), so uploading the same file twice reuses one
 * entry. The server resolves these inputs itself (they never reach the
 * registry) and transcribes them with the core speech-to-text chain.
 *
 * Where the bytes live:
 * - When the storage backend can hold blobs (the Cloudflare backend with an
 *   R2 bucket bound), bytes go to R2 and the upload's details and
 *   transcripts go to the KvStore with the upload's TTL, so every Worker
 *   isolate sees them.
 * - Otherwise in this process's memory, dropped when they expire or when a
 *   new upload needs the room (oldest first), and lost on restart.
 *
 * Transcripts of uploads are kept next to the upload, never in the library,
 * and expire with it.
 */
import {
  type AudioInput,
  type KvStore,
  type Storage,
  type VideoContext,
  type VideoMetadata,
  type VideoRef,
  Vid2ContextError,
} from '@vid2context/core';

export const UPLOAD_PREFIX = 'upload:';
const UPLOAD_ID = /^upload:([0-9a-f]{64})$/;

export interface UploadEntry {
  sha256: string;
  filename: string;
  mimeType: string;
  data: Uint8Array;
  createdAt: number;
  expiresAt: number;
}

/** A storage backend that can hold large binary objects (CloudflareStorage on R2). */
export interface BlobStore {
  putBlob(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  getBlob(key: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  deleteBlob(key: string): Promise<void>;
}

export function hasBlobs<S extends Storage>(storage: S): storage is S & BlobStore {
  const s = storage as S & Partial<BlobStore>;
  return typeof s.putBlob === 'function' && typeof s.getBlob === 'function' && typeof s.deleteBlob === 'function';
}

/** Where an upload call may persist: the library storage and the KvStore the server uses. */
export interface UploadBackend {
  storage: Storage;
  kv: KvStore;
}

interface UploadMeta {
  filename: string;
  mimeType: string;
  bytes: number;
  createdAt: number;
  expiresAt: number;
}

const metaKey = (sha: string) => `uploads:meta:${sha}`;
const contextKey = (sha: string, lang: string) => `uploads:ctx:${sha}:${lang}`;
const blobKey = (sha: string) => `uploads/${sha}`;

/** True for inputs starting with `upload:` (well-formed or not, so typos get a clear error). */
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

function parseId(input: string): string {
  const m = UPLOAD_ID.exec(input.trim().toLowerCase());
  if (!m) {
    throw new Vid2ContextError('bad-request', `"${input.slice(0, 80)}" is not a valid upload id.`, {
      hint: 'Upload ids look like upload:<64 hex characters>, as returned by POST /api/v1/uploads.',
    });
  }
  return m[1] as string;
}

const ttlSecUntil = (expiresAt: number, now: number) => Math.max(1, Math.ceil((expiresAt - now) / 1000));

export class UploadStore {
  /** Uploads held in memory: all of them in memory mode, a cache of recent ones in blob mode. */
  private entries = new Map<string, UploadEntry>();
  /** Transcripts in memory, by sha256 then language ('' for auto-detect). */
  private contexts = new Map<string, Map<string, VideoContext>>();

  private sweep(now: number): void {
    for (const [id, e] of this.entries) {
      if (e.expiresAt > now) continue;
      this.entries.delete(id);
      this.contexts.delete(id);
    }
  }

  private remember(entry: UploadEntry, maxTotalBytes: number): void {
    let total = entry.data.byteLength;
    for (const e of this.entries.values()) total += e.data.byteLength;
    for (const drop of [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (total <= maxTotalBytes) break;
      this.entries.delete(drop.sha256);
      this.contexts.delete(drop.sha256);
      total -= drop.data.byteLength;
    }
    this.entries.set(entry.sha256, entry);
  }

  /**
   * Store an upload. `maxTotalBytes` caps what uploads held in memory may
   * take together; the oldest are dropped first. With a blob-capable backend
   * the bytes go there too, and memory is only a cache.
   */
  async put(
    data: Uint8Array,
    filename: string,
    mimeType: string,
    opts: { ttlMs: number; maxTotalBytes: number; backend?: UploadBackend; now?: number },
  ): Promise<{ entry: UploadEntry; persisted: 'blob' | 'memory' }> {
    const now = opts.now ?? Date.now();
    this.sweep(now);
    const sha256 = await sha256Hex(data);
    const expiresAt = now + opts.ttlMs;
    let persisted: 'blob' | 'memory' = 'memory';
    const backend = opts.backend;
    if (backend && hasBlobs(backend.storage)) {
      try {
        await backend.storage.putBlob(blobKey(sha256), data, mimeType);
        const meta: UploadMeta = { filename, mimeType, bytes: data.byteLength, createdAt: now, expiresAt };
        await backend.kv.kvSet(metaKey(sha256), meta, { ttlSec: ttlSecUntil(expiresAt, now) });
        persisted = 'blob';
      } catch (err) {
        // A backend without a bucket bound answers no-provider; the upload then lives in memory only.
        if (!(err instanceof Vid2ContextError && err.code === 'no-provider')) throw err;
      }
    }
    const existing = this.entries.get(sha256);
    if (existing) {
      existing.expiresAt = expiresAt;
      return { entry: existing, persisted };
    }
    const entry: UploadEntry = { sha256, filename, mimeType, data, createdAt: now, expiresAt };
    this.remember(entry, opts.maxTotalBytes);
    return { entry, persisted };
  }

  /** The live upload for an `upload:<sha256>` input. Throws `bad-request` for a malformed id and `not-found` when it expired or never existed. */
  async get(
    input: string,
    opts: { ttlMin: number; maxTotalBytes: number; backend?: UploadBackend; now?: number },
  ): Promise<UploadEntry> {
    const sha = parseId(input);
    const now = opts.now ?? Date.now();
    this.sweep(now);
    const cached = this.entries.get(sha);
    if (cached) return cached;
    const backend = opts.backend;
    const blobs = backend && hasBlobs(backend.storage) ? backend.storage : undefined;
    if (backend && blobs) {
      const meta = await backend.kv.kvGet<UploadMeta>(metaKey(sha));
      const blob = meta && meta.expiresAt > now ? await blobs.getBlob(blobKey(sha)).catch(() => null) : null;
      if (meta && blob) {
        const entry: UploadEntry = {
          sha256: sha,
          filename: meta.filename,
          mimeType: meta.mimeType,
          data: blob.data,
          createdAt: meta.createdAt,
          expiresAt: meta.expiresAt,
        };
        this.remember(entry, opts.maxTotalBytes);
        return entry;
      }
      // Expired or never stored here: drop any bytes left behind, best effort (an R2 lifecycle rule is the backstop).
      if (!meta) await blobs.deleteBlob(blobKey(sha)).catch(() => undefined);
    }
    throw new Vid2ContextError('not-found', `No upload ${input.slice(0, 80)} on this server.`, {
      hint: `Uploads are kept for ${opts.ttlMin} minutes${blobs ? '' : ' in memory and are lost on restart'}. Upload the file again with POST /api/v1/uploads.`,
    });
  }

  async getContext(entry: UploadEntry, lang: string, backend?: UploadBackend): Promise<VideoContext | null> {
    const hit = this.contexts.get(entry.sha256)?.get(lang);
    if (hit) return hit;
    if (backend && hasBlobs(backend.storage)) return backend.kv.kvGet<VideoContext>(contextKey(entry.sha256, lang));
    return null;
  }

  async putContext(entry: UploadEntry, lang: string, context: VideoContext, backend?: UploadBackend, now = Date.now()): Promise<void> {
    let byLang = this.contexts.get(entry.sha256);
    if (!byLang) {
      byLang = new Map();
      this.contexts.set(entry.sha256, byLang);
    }
    byLang.set(lang, context);
    if (backend && hasBlobs(backend.storage)) {
      await backend.kv.kvSet(contextKey(entry.sha256, lang), context, { ttlSec: ttlSecUntil(entry.expiresAt, now) });
    }
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
