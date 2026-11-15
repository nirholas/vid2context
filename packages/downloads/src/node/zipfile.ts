/**
 * A .zip of files on disk, streamed: each file is read twice (once for its
 * CRC, once to copy it) and never held in memory, so a batch of videos can
 * be packed on a small server. Media is already compressed, so entries are
 * stored, not deflated. ZIP64 is not written; past 4 GiB the archive is
 * refused, as core's zip writer does.
 */

import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dosDateTime, Vid2ContextError } from '@vid2context/core';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of a file, read as a stream. */
export async function fileCrc32(path: string, signal?: AbortSignal): Promise<number> {
  let c = 0xffffffff;
  for await (const chunk of createReadStream(path, signal ? { signal } : {})) {
    const b = chunk as Buffer;
    for (let i = 0; i < b.length; i++) c = (TABLE[(c ^ (b[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const MAX_32 = 0xffffffff;

function tooLarge(what: string): Vid2ContextError {
  return new Vid2ContextError('too-large', `The .zip would be too large: ${what}.`, {
    hint: 'Download the items without zip, or split the batch.',
  });
}

export interface ZipInput {
  path: string;
  /** Name inside the archive (forward slashes). */
  name: string;
}

/** Write `files` into a stored .zip at `dest`. Returns the archive size. */
export async function zipFiles(files: ZipInput[], dest: string, signal?: AbortSignal): Promise<number> {
  if (files.length > 0xffff) throw tooLarge(`${files.length} files`);
  const out = createWriteStream(dest);
  const write = async (b: Uint8Array) => {
    if (!out.write(b)) await once(out, 'drain');
  };
  const central: Uint8Array[] = [];
  let offset = 0;
  const { date, time } = dosDateTime(new Date());
  try {
    for (const f of files) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const size = (await stat(f.path)).size;
      if (size >= MAX_32) throw tooLarge(`"${f.name}" is 4 GiB or more`);
      if (offset + size >= MAX_32) throw tooLarge('the archive passed 4 GiB');
      const crc = await fileCrc32(f.path, signal);
      const name = new TextEncoder().encode(f.name);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);
      await write(local);
      for await (const chunk of createReadStream(f.path, signal ? { signal } : {})) await write(chunk as Buffer);
      const c = new Uint8Array(46 + name.length);
      const cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      c.set(name, 46);
      central.push(c);
      offset += local.length + size;
    }
    const cdOffset = offset;
    let cdSize = 0;
    for (const c of central) {
      await write(c);
      cdSize += c.length;
    }
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);
    await write(end);
    out.end();
    await once(out, 'finish');
    return cdOffset + cdSize + 22;
  } catch (err) {
    out.destroy();
    throw err;
  }
}
