/**
 * Rasterize the project logo (packages/discovery/assets/logo.svg: a rounded
 * orange square with a white play triangle, on a 32-unit grid) into the PNG
 * sizes a browser extension needs. Pure Node, no image libraries: each pixel
 * is supersampled 4x4 for anti-aliasing and written as an RGBA PNG.
 */
import { deflateSync } from 'node:zlib';

const ORANGE = [0xe8, 0x59, 0x0c] as const;
const WHITE = [0xff, 0xff, 0xff] as const;
const SAMPLES = 4;

function inRoundedSquare(x: number, y: number): boolean {
  const r = 7;
  const cx = Math.min(Math.max(x, r), 32 - r);
  const cy = Math.min(Math.max(y, r), 32 - r);
  return x >= 0 && x <= 32 && y >= 0 && y <= 32 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** The triangle M12 9.5 v13 l10 -6.5 z. */
function inTriangle(x: number, y: number): boolean {
  const a = [12, 9.5];
  const b = [12, 22.5];
  const c = [22, 16];
  const side = (p: number[], q: number[]) =>
    ((q[0] as number) - (p[0] as number)) * (y - (p[1] as number)) -
    ((q[1] as number) - (p[1] as number)) * (x - (p[0] as number));
  const d1 = side(a, b);
  const d2 = side(b, c);
  const d3 = side(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function iconPng(size: number): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const scale = 32 / size;
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let cover = 0;
      let white = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          if (!inRoundedSquare(x, y)) continue;
          cover++;
          if (inTriangle(x, y)) white++;
        }
      }
      const n = SAMPLES * SAMPLES;
      const w = cover ? white / cover : 0;
      const o = row + 1 + px * 4;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round((ORANGE[i] as number) * (1 - w) + (WHITE[i] as number) * w);
      raw[o + 3] = Math.round((cover / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const ICON_SIZES = [16, 32, 48, 128] as const;
