/**
 * A dependency-free ZIP writer that runs on Node 22+, Workers and browsers.
 *
 * Each entry is compressed in memory before it is written, so local headers
 * carry the real sizes and CRC (no data descriptors), which every unzip tool
 * reads. Compression is raw deflate through `CompressionStream` when the
 * runtime has it; an entry is stored instead when deflate would not shrink it
 * or when `CompressionStream` is missing. ZIP64 is not written: inputs past
 * the ZIP32 limits are refused with a clear error instead of a corrupt file.
 */
import { Vid2ContextError } from '../errors.ts';
import { crc32 } from './crc32.ts';

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. Stored as UTF-8. */
  path: string;
  data: Uint8Array;
  /** Modification time. Defaults to the archive's `date`. */
  date?: Date;
}

export interface ZipOptions {
  /** Modification time for entries without their own. Defaults to now. Pass one for byte-identical output. */
  date?: Date;
  /** 'auto' deflates when it helps and the runtime can; 'store' never compresses. Default 'auto'. */
  compression?: 'auto' | 'store';
}

const MAX_ENTRIES = 0xffff;
const MAX_32 = 0xffffffff;
const FLAG_UTF8 = 0x0800;
const VERSION = 20;

function tooLarge(what: string): Vid2ContextError {
  return new Vid2ContextError('too-large', `The archive is too large for a ZIP file without ZIP64: ${what}.`, {
    hint: 'Split the bundle into smaller ones (fewer videos or fewer formats per bundle).',
  });
}

/** DOS date and time fields, from UTC so the same `Date` gives the same bytes in every time zone. */
export function dosDateTime(d: Date): { date: number; time: number } {
  let year = d.getUTCFullYear();
  if (year < 1980) return { date: (1 << 5) | 1, time: 0 };
  if (year > 2107) year = 2107;
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
  };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === 'undefined') return undefined;
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Written {
  name: Uint8Array;
  crc: number;
  method: number;
  compressedSize: number;
  size: number;
  date: number;
  time: number;
  offset: number;
}

const encoder = new TextEncoder();

function localHeader(w: Written): Uint8Array {
  const out = new Uint8Array(30 + w.name.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, FLAG_UTF8, true);
  v.setUint16(8, w.method, true);
  v.setUint16(10, w.time, true);
  v.setUint16(12, w.date, true);
  v.setUint32(14, w.crc, true);
  v.setUint32(18, w.compressedSize, true);
  v.setUint32(22, w.size, true);
  v.setUint16(26, w.name.length, true);
  v.setUint16(28, 0, true);
  out.set(w.name, 30);
  return out;
}

function centralHeader(w: Written): Uint8Array {
  const out = new Uint8Array(46 + w.name.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, (3 << 8) | VERSION, true); // made by: Unix, so external attributes carry the mode
  v.setUint16(6, VERSION, true);
  v.setUint16(8, FLAG_UTF8, true);
  v.setUint16(10, w.method, true);
  v.setUint16(12, w.time, true);
  v.setUint16(14, w.date, true);
  v.setUint32(16, w.crc, true);
  v.setUint32(20, w.compressedSize, true);
  v.setUint32(24, w.size, true);
  v.setUint16(28, w.name.length, true);
  v.setUint16(30, 0, true); // extra length
  v.setUint16(32, 0, true); // comment length
  v.setUint16(34, 0, true); // disk number
  v.setUint16(36, 0, true); // internal attributes
  v.setUint32(38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
  v.setUint32(42, w.offset, true);
  out.set(w.name, 46);
  return out;
}

function endRecord(count: number, cdSize: number, cdOffset: number): Uint8Array {
  const out = new Uint8Array(22);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  return out;
}

async function* toAsync<T>(items: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
  for await (const item of items) yield item;
}

/**
 * Stream a ZIP archive. Entries are read one at a time, as they are produced,
 * and each is written as soon as it is compressed. Errors (such as
 * `too-large`) surface as a stream error.
 */
export function zipStream(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  opts: ZipOptions = {},
): ReadableStream<Uint8Array> {
  if (Array.isArray(entries) && entries.length > MAX_ENTRIES) throw tooLarge(`${entries.length} files (the limit is 65,535)`);
  const fallbackDate = opts.date ?? new Date();
  const store = opts.compression === 'store';
  const iter = toAsync(entries);
  const written: Written[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      const next = await iter.next();
      if (!next.done) {
        const entry = next.value;
        if (written.length >= MAX_ENTRIES) throw tooLarge('more than 65,535 files');
        const path = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!path || path.split('/').some((p) => p === '..')) {
          throw new Vid2ContextError('bad-request', `Unsafe path in archive: "${entry.path}".`, {
            hint: 'Use relative paths without ".." segments.',
          });
        }
        if (seen.has(path)) {
          throw new Vid2ContextError('bad-request', `Duplicate path in archive: "${path}".`, {
            hint: 'Give every file in the bundle a unique path.',
          });
        }
        seen.add(path);
        const name = encoder.encode(path);
        if (name.length > 0xffff) throw tooLarge(`a file name of ${name.length} bytes`);
        const size = entry.data.length;
        if (size >= MAX_32) throw tooLarge(`"${path}" is 4 GiB or more`);
        const deflated = store || size === 0 ? undefined : await deflateRaw(entry.data);
        const useDeflate = deflated !== undefined && deflated.length < size;
        const body = useDeflate ? deflated : entry.data;
        if (offset >= MAX_32) throw tooLarge('the archive passed 4 GiB');
        const { date, time } = dosDateTime(entry.date ?? fallbackDate);
        const w: Written = {
          name,
          crc: crc32(entry.data),
          method: useDeflate ? 8 : 0,
          compressedSize: body.length,
          size,
          date,
          time,
          offset,
        };
        const header = localHeader(w);
        written.push(w);
        offset += header.length + body.length;
        controller.enqueue(header);
        if (body.length) controller.enqueue(body);
        return;
      }
      const cdOffset = offset;
      let cdSize = 0;
      for (const w of written) {
        const c = centralHeader(w);
        cdSize += c.length;
        controller.enqueue(c);
      }
      if (cdOffset >= MAX_32 || cdSize >= MAX_32) throw tooLarge('the central directory passed 4 GiB');
      controller.enqueue(endRecord(written.length, cdSize, cdOffset));
      finished = true;
      controller.close();
    },
    async cancel() {
      await iter.return(undefined);
    },
  });
}

/** Concatenate a byte stream into one array. */
export async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The whole archive as one byte array. */
export async function zipToBytes(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  opts: ZipOptions = {},
): Promise<Uint8Array> {
  return collectBytes(zipStream(entries, opts));
}
