/** Read a .zip (stored or deflated entries) from its central directory, to check archives the toolkit writes. */
import { inflateRawSync } from 'node:zlib';

export function unzipEntries(zip: Uint8Array): { path: string; data: Uint8Array }[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip: no end record');
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out: { path: string; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('bad central header');
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true);
    const comment = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const path = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    const raw = zip.subarray(start, start + csize);
    out.push({ path, data: method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
