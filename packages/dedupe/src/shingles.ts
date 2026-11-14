/**
 * Word shingles with positions and times. A transcript becomes one stream of
 * normalized words, each stamped with a time interpolated inside its caption
 * segment; shingle i is words i..i+k-1 and carries the time of word i.
 */
import type { VideoContext } from '@vid2context/core';
import { normalizeWords } from './normalize.ts';

/** One transcript prepared for matching. */
export interface ShingledDoc {
  videoId: string;
  words: number;
  /** Start time of each word, seconds. */
  wordStart: Float64Array;
  /** End time of each word, seconds. */
  wordEnd: Float64Array;
  /** 52-bit shingle keys, one per position. */
  keys: Float64Array;
  /** 32-bit shingle hashes (the high part of each key), fed to MinHash. */
  hashes: Uint32Array;
  durationSec: number;
}

/** murmur3's 32-bit finalizer: a fast, well-mixed integer hash. */
export function fmix32(h: number): number {
  let x = h;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** FNV-1a over UTF-16 code units. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function combine(h: number, v: number): number {
  return fmix32((h ^ (v + 0x9e3779b9 + (h << 6) + (h >>> 2))) >>> 0);
}

/** Duration from metadata, else the end of the last segment. */
export function durationOf(context: VideoContext): number {
  const d = context.metadata.durationSec;
  if (typeof d === 'number' && d > 0) return d;
  let end = 0;
  for (const s of context.transcript.segments) if (s.endSec > end) end = s.endSec;
  return end;
}

export function shingle(context: VideoContext, k: number): ShingledDoc {
  const wordHashes: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const seg of context.transcript.segments) {
    const words = normalizeWords(seg.text);
    if (words.length === 0) continue;
    const span = Math.max(0, seg.endSec - seg.startSec);
    const step = span / words.length;
    for (let i = 0; i < words.length; i++) {
      wordHashes.push(fnv1a(words[i] as string));
      starts.push(seg.startSec + step * i);
      ends.push(seg.startSec + step * (i + 1));
    }
  }
  const n = wordHashes.length;
  const count = Math.max(0, n - k + 1);
  const keys = new Float64Array(count);
  const hashes = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    let h1 = 0x2545f491;
    let h2 = 0x9b05688c;
    for (let j = 0; j < k; j++) {
      const w = wordHashes[i + j] as number;
      h1 = combine(h1, w);
      h2 = combine(h2, w ^ 0x5bd1e995);
    }
    hashes[i] = h1;
    // 32 bits from h1 and 20 from h2: a 52-bit key, exact in a double, so collisions between distinct shingles are negligible.
    keys[i] = h1 * 0x100000 + (h2 >>> 12);
  }
  return {
    videoId: context.metadata.ref.id,
    words: n,
    wordStart: Float64Array.from(starts),
    wordEnd: Float64Array.from(ends),
    keys,
    hashes,
    durationSec: durationOf(context),
  };
}
