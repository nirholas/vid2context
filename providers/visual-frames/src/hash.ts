/**
 * Perceptual frame hashing in pure TypeScript (runtime-neutral).
 *
 * The frame pipeline asks ffmpeg for a small grayscale copy of every sampled
 * frame (THUMB_WIDTH x THUMB_HEIGHT, one byte per pixel). From that thumbnail:
 *
 *   dHash      64-bit difference hash: shrink to 9x8 by area averaging, then
 *              one bit per pixel saying whether it is brighter than its right
 *              neighbour. Re-encoding, subtitles and small changes flip few
 *              bits; a different slide flips many.
 *   sharpness  variance of the Laplacian: high for crisp text, low for blurry
 *              frames caught mid-transition.
 */

/** Size of the grayscale thumbnail ffmpeg emits for hashing (aspect ratio is ignored). */
export const THUMB_WIDTH = 128;
export const THUMB_HEIGHT = 72;

export interface GrayImage {
  width: number;
  height: number;
  /** One luminance byte per pixel, row-major. */
  data: Uint8Array;
}

/** Luminance (ITU-R BT.601) from RGBA pixels, for callers that decode images themselves. */
export function grayFromRgba(rgba: Uint8Array, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = Math.round(0.299 * (rgba[p] ?? 0) + 0.587 * (rgba[p + 1] ?? 0) + 0.114 * (rgba[p + 2] ?? 0));
  }
  return { width, height, data };
}

/** Area-average resize (a box filter): every source pixel contributes by the share of it each target pixel covers. */
export function resizeGray(img: GrayImage, width: number, height: number): GrayImage {
  const out = new Uint8Array(width * height);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let ty = 0; ty < height; ty++) {
    const y0 = ty * sy;
    const y1 = y0 + sy;
    for (let tx = 0; tx < width; tx++) {
      const x0 = tx * sx;
      const x1 = x0 + sx;
      let sum = 0;
      let area = 0;
      for (let y = Math.floor(y0); y < Math.min(Math.ceil(y1), img.height); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = Math.floor(x0); x < Math.min(Math.ceil(x1), img.width); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          sum += (img.data[y * img.width + x] ?? 0) * w;
          area += w;
        }
      }
      out[ty * width + tx] = area > 0 ? Math.round(sum / area) : 0;
    }
  }
  return { width, height, data: out };
}

/** 64-bit difference hash as 16 lowercase hex characters. */
export function dHash(img: GrayImage): string {
  const small = resizeGray(img, 9, 8);
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) {
      const left = small.data[y * 9 + x] ?? 0;
      const right = small.data[y * 9 + x + 1] ?? 0;
      byte = (byte << 1) | (left > right ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

const POPCOUNT = Array.from({ length: 16 }, (_, n) => (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1));

/** Number of differing bits between two dHash strings (0 = same picture, 64 = opposite). */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error(`hash length mismatch: ${a.length} vs ${b.length}`);
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT[Number.parseInt(a[i] ?? '0', 16) ^ Number.parseInt(b[i] ?? '0', 16)] ?? 0;
  return d;
}

/** Variance of the 4-neighbour Laplacian. Higher means sharper edges (crisp text, settled slides). */
export function sharpness(img: GrayImage): number {
  const { width: w, height: h, data } = img;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        4 * (data[i] ?? 0) - (data[i - 1] ?? 0) - (data[i + 1] ?? 0) - (data[i - w] ?? 0) - (data[i + w] ?? 0);
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}
