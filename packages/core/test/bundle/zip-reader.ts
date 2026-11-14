/**
 * A small, strict ZIP reader for tests: parses the end record and central
 * directory, reads each local header, inflates with node:zlib and verifies
 * CRC-32 and sizes. Test code only; src/ must stay free of node built-ins.
 */
import { inflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/bundle/crc32.ts';

export interface ReadEntry {
  path: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  dosDate: number;
  dosTime: number;
  data: Uint8Array;
}

export function readZip(bytes: Uint8Array): ReadEntry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (v.getUint32(eocd, true) !== 0x06054b50) throw new Error('no end of central directory record at the end');
  const count = v.getUint16(eocd + 10, true);
  if (v.getUint16(eocd + 8, true) !== count) throw new Error('entry counts disagree');
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (cdOffset + cdSize !== eocd) throw new Error('central directory does not end at the end record');
  const dec = new TextDecoder('utf-8', { fatal: true });
  const out: ReadEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error(`bad central header ${i}`);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const dosTime = v.getUint16(p + 12, true);
    const dosDate = v.getUint16(p + 14, true);
    const crc = v.getUint32(p + 16, true);
    const compressedSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const path = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (v.getUint32(local, true) !== 0x04034b50) throw new Error(`bad local header for ${path}`);
    const lFlags = v.getUint16(local + 6, true);
    const lMethod = v.getUint16(local + 8, true);
    const lCrc = v.getUint32(local + 14, true);
    const lCompressed = v.getUint32(local + 18, true);
    const lSize = v.getUint32(local + 22, true);
    const lNameLen = v.getUint16(local + 26, true);
    const lExtraLen = v.getUint16(local + 28, true);
    const lPath = dec.decode(bytes.subarray(local + 30, local + 30 + lNameLen));
    if (lPath !== path || lFlags !== flags || lMethod !== method) throw new Error(`local and central headers disagree for ${path}`);
    if (lCrc !== crc || lCompressed !== compressedSize || lSize !== size) throw new Error(`sizes or CRC disagree for ${path}`);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw));
    else throw new Error(`unknown method ${method} for ${path}`);
    if (data.length !== size) throw new Error(`size mismatch for ${path}`);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${path}`);
    out.push({ path, method, flags, crc, compressedSize, size, dosDate, dosTime, data });
  }
  return out;
}
