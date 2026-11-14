/**
 * Candidate search: MinHash signatures with LSH banding, so only pairs that
 * share text are compared exactly.
 *
 * Whole-transcript MinHash estimates Jaccard similarity, which is tiny for a
 * 3-minute clip of a 40-minute video (about 3/40 even when every clip word is
 * in the original), so whole-document signatures would miss clips. Instead
 * each transcript is cut into windows of two consecutive blocks of shingles
 * (stride one block); a clip's windows overlap some window of its original by
 * at least three quarters, which LSH finds easily. Short transcripts are one
 * window.
 */
import { fmix32, type ShingledDoc } from './shingles.ts';

/** mulberry32: a tiny seeded PRNG, so the hash family is the same on every run and runtime. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export function hashSeeds(numHashes: number, seed: number): Uint32Array {
  const next = mulberry32(seed);
  const seeds = new Uint32Array(numHashes);
  for (let i = 0; i < numHashes; i++) seeds[i] = next();
  return seeds;
}

/** Block signatures for one document: blocks[b] holds numHashes minimums. */
function blockSignatures(doc: ShingledDoc, seeds: Uint32Array, blockShingles: number): Uint32Array[] {
  const m = seeds.length;
  const blocks: Uint32Array[] = [];
  const n = doc.hashes.length;
  for (let start = 0; start < n; start += blockShingles) {
    const sig = new Uint32Array(m).fill(0xffffffff);
    const end = Math.min(n, start + blockShingles);
    for (let p = start; p < end; p++) {
      const x = doc.hashes[p] as number;
      for (let i = 0; i < m; i++) {
        const v = fmix32(x ^ (seeds[i] as number));
        if (v < (sig[i] as number)) sig[i] = v;
      }
    }
    blocks.push(sig);
  }
  return blocks;
}

/** Window signatures: the element-wise minimum of each pair of consecutive blocks (one window when there are at most two blocks). */
export function windowSignatures(doc: ShingledDoc, seeds: Uint32Array, blockShingles: number): Uint32Array[] {
  const blocks = blockSignatures(doc, seeds, blockShingles);
  if (blocks.length <= 2) {
    if (blocks.length === 0) return [];
    const sig = Uint32Array.from(blocks[0] as Uint32Array);
    if (blocks[1]) for (let i = 0; i < sig.length; i++) sig[i] = Math.min(sig[i] as number, (blocks[1] as Uint32Array)[i] as number);
    return [sig];
  }
  const windows: Uint32Array[] = [];
  for (let b = 0; b + 1 < blocks.length; b++) {
    const x = blocks[b] as Uint32Array;
    const y = blocks[b + 1] as Uint32Array;
    const sig = new Uint32Array(x.length);
    for (let i = 0; i < x.length; i++) sig[i] = Math.min(x[i] as number, y[i] as number);
    windows.push(sig);
  }
  return windows;
}

/**
 * Pairs of documents (indices, i < j) that share at least one LSH bucket in
 * any window. Sorted, so the caller compares them in a deterministic order.
 */
export function candidatePairs(
  docs: ShingledDoc[],
  opts: { numHashes: number; bands: number; seed: number; blockShingles: number },
): { pairs: [number, number][]; windows: number } {
  const seeds = hashSeeds(opts.numHashes, opts.seed);
  const rows = Math.max(1, Math.floor(opts.numHashes / opts.bands));
  const bands = Math.floor(opts.numHashes / rows);
  const buckets: Map<number, number[]>[] = Array.from({ length: bands }, () => new Map());
  let windows = 0;
  for (let d = 0; d < docs.length; d++) {
    for (const sig of windowSignatures(docs[d] as ShingledDoc, seeds, opts.blockShingles)) {
      windows++;
      for (let b = 0; b < bands; b++) {
        let h = 0x3c6ef372 ^ b;
        for (let r = 0; r < rows; r++) h = fmix32((h ^ (sig[b * rows + r] as number)) + 0x9e3779b9);
        const bucket = (buckets[b] as Map<number, number[]>).get(h);
        if (!bucket) (buckets[b] as Map<number, number[]>).set(h, [d]);
        else if (bucket[bucket.length - 1] !== d) bucket.push(d);
      }
    }
  }
  const n = docs.length;
  const seen = new Set<number>();
  for (const band of buckets) {
    for (const members of band.values()) {
      if (members.length < 2) continue;
      for (let x = 0; x < members.length; x++) {
        for (let y = x + 1; y < members.length; y++) {
          const i = members[x] as number;
          const j = members[y] as number;
          seen.add(i < j ? i * n + j : j * n + i);
        }
      }
    }
  }
  const pairs = [...seen].sort((a, b) => a - b).map((k): [number, number] => [Math.floor(k / n), k % n]);
  return { pairs, windows };
}
