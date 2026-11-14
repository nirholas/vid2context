/**
 * findDuplicates: group reuploads and clips in a collection so a brief counts
 * each original once. Pure and runtime-neutral: no network, no Node built-ins.
 */
import type { VideoContext } from '@vid2context/core';
import { type Alignment, align, runWords } from './align.ts';
import { candidatePairs } from './minhash.ts';
import { normalizeWords } from './normalize.ts';
import { resolveOptions } from './options.ts';
import { type ShingledDoc, shingle } from './shingles.ts';
import type {
  DedupeOptions,
  DuplicateGroup,
  DuplicatesResult,
  Evidence,
  EvidenceMethod,
  GroupMember,
  RelatedPair,
  TimeRange,
} from './types.ts';

type Kind = 'reupload' | 'clip' | 'related' | 'distinct';

interface Pair {
  /** Index of the shorter video (by duration) and of the longer one. */
  a: number;
  b: number;
  al: Alignment;
  kind: Kind;
  method: EvidenceMethod;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Words that say nothing about which video a title names. */
const TITLE_NOISE = new Set([
  'reupload',
  'reuploaded',
  're',
  'upload',
  'official',
  'video',
  'hd',
  '4k',
  '1080p',
  '720p',
  'full',
  'remastered',
  'enhanced',
  'original',
  'edited',
  'version',
  'subtitles',
  'subtitle',
  'with',
  'the',
  'a',
  'an',
  'of',
  'and',
  'in',
  'on',
  'to',
  'by',
]);

function titleWords(title: string): Set<string> {
  return new Set(normalizeWords(title).filter((w) => !TITLE_NOISE.has(w)));
}

/** Jaccard similarity of title words, ignoring words such as "reupload", "official" and "HD". */
export function titleSimilarity(a: string, b: string): number {
  const x = titleWords(a);
  const y = titleWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

function sameChannel(a: VideoContext, b: VideoContext): boolean {
  const x = a.metadata.channel;
  const y = b.metadata.channel;
  if (!x || !y) return false;
  if (x.id && y.id) return x.id === y.id;
  return x.name.trim().toLowerCase() === y.name.trim().toLowerCase();
}

function viewCount(c: VideoContext): number {
  const v = c.metadata.extra?.viewCount;
  return typeof v === 'number' && Number.isFinite(v) ? v : -1;
}

function publishedMs(c: VideoContext): number | undefined {
  const t = c.metadata.publishedAt ? Date.parse(c.metadata.publishedAt) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r] as number;
    let c = x;
    while (this.parent[c] !== r) {
      const next = this.parent[c] as number;
      this.parent[c] = r;
      c = next;
    }
    return r;
  }
  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx !== ry) this.parent[Math.max(rx, ry)] = Math.min(rx, ry);
  }
}

const METHOD_WEAKNESS: Record<EvidenceMethod, number> = { shingles: 0, 'shingles+metadata': 1, composed: 2 };

/**
 * Find reuploads and clips among the given contexts.
 *
 * Groups come back in input order of their earliest member. Every video
 * appears in `representativeOf`, mapped to the original it counts as.
 */
export function findDuplicates(contexts: VideoContext[], options: DedupeOptions = {}): DuplicatesResult {
  const o = resolveOptions(options);
  const skipped: DuplicatesResult['skipped'] = [];
  const representativeOf: Record<string, string> = {};

  // Unique inputs, in order.
  const ctxs: VideoContext[] = [];
  const seenIds = new Set<string>();
  for (const c of contexts) {
    const id = c.metadata.ref.id;
    if (seenIds.has(id)) {
      skipped.push({ videoId: id, reason: 'duplicate-input' });
      continue;
    }
    seenIds.add(id);
    ctxs.push(c);
  }

  // Shingle; too-short transcripts cannot be judged and stand alone.
  const docs: ShingledDoc[] = [];
  const docCtx: VideoContext[] = [];
  for (const c of ctxs) {
    const doc = shingle(c, o.shingleSize);
    representativeOf[doc.videoId] = doc.videoId;
    if (doc.words < Math.max(o.minWords, o.shingleSize)) {
      skipped.push({ videoId: doc.videoId, reason: 'too-short' });
      continue;
    }
    docs.push(doc);
    docCtx.push(c);
  }

  const { pairs: candidates, windows } = candidatePairs(docs, o);
  const alignOpts = { shingleSize: o.shingleSize, maxGap: o.maxGap, minRunMatches: o.minRunMatches, maxOccurrences: o.maxOccurrences };

  const metaSupport = (x: number, y: number): boolean =>
    sameChannel(docCtx[x] as VideoContext, docCtx[y] as VideoContext) ||
    titleSimilarity((docCtx[x] as VideoContext).metadata.title, (docCtx[y] as VideoContext).metadata.title) >= o.titleSimilarity;

  const similarLength = (x: number, y: number): boolean => {
    const dx = (docs[x] as ShingledDoc).durationSec;
    const dy = (docs[y] as ShingledDoc).durationSec;
    const longer = Math.max(dx, dy);
    return longer > 0 && Math.abs(dx - dy) <= Math.max(o.durationTolerance * longer, o.durationSlackSec);
  };

  /** Shorter first: by duration, then by word count, then by input order. */
  const order = (x: number, y: number): [number, number] => {
    const dx = docs[x] as ShingledDoc;
    const dy = docs[y] as ShingledDoc;
    if (dx.durationSec !== dy.durationSec) return dx.durationSec < dy.durationSec ? [x, y] : [y, x];
    if (dx.words !== dy.words) return dx.words < dy.words ? [x, y] : [y, x];
    return x < y ? [x, y] : [y, x];
  };

  const pairCache = new Map<number, Pair>();
  const evaluate = (x: number, y: number): Pair => {
    const [a, b] = order(x, y);
    const key = a * docs.length + b;
    const cached = pairCache.get(key);
    if (cached) return cached;
    const al = align(docs[a] as ShingledDoc, docs[b] as ShingledDoc, alignOpts);
    let kind: Kind = 'distinct';
    let method: EvidenceMethod = 'shingles';
    const close = (threshold: number) => al.overlapA > threshold - o.metadataMargin && metaSupport(a, b);
    if (similarLength(a, b)) {
      if (al.overlapA > o.reuploadOverlap) kind = 'reupload';
      else if (close(o.reuploadOverlap)) {
        kind = 'reupload';
        method = 'shingles+metadata';
      }
    } else if (al.overlapA > o.clipOverlap) kind = 'clip';
    else if (close(o.clipOverlap)) {
      kind = 'clip';
      method = 'shingles+metadata';
    }
    if (kind === 'distinct' && al.runs.some((r) => runWords(r, o.shingleSize) >= o.relatedMinWords)) kind = 'related';
    const pair: Pair = { a, b, al, kind, method };
    pairCache.set(key, pair);
    return pair;
  };

  const evaluated = candidates.map(([x, y]) => evaluate(x, y));

  // Reupload clusters.
  const uf = new UnionFind(docs.length);
  const reuploadEdges = new Map<number, number[]>();
  for (const p of evaluated) {
    if (p.kind !== 'reupload') continue;
    uf.union(p.a, p.b);
    for (const [u, v] of [
      [p.a, p.b],
      [p.b, p.a],
    ] as const) {
      const list = reuploadEdges.get(u);
      if (list) list.push(v);
      else reuploadEdges.set(u, [v]);
    }
  }
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < docs.length; i++) {
    const r = uf.find(i);
    const list = clusters.get(r);
    if (list) list.push(i);
    else clusters.set(r, [i]);
  }

  /** The likely original among videos of one clip: earliest published, then most viewed, then creator captions, then longer, then input order. */
  const better = (x: number, y: number): boolean => {
    const cx = docCtx[x] as VideoContext;
    const cy = docCtx[y] as VideoContext;
    const px = publishedMs(cx);
    const py = publishedMs(cy);
    if (px !== undefined && py !== undefined && px !== py) return px < py;
    if (viewCount(cx) !== viewCount(cy)) return viewCount(cx) > viewCount(cy);
    const crx = cx.transcript.origin === 'creator-captions';
    const cry = cy.transcript.origin === 'creator-captions';
    if (crx !== cry) return crx;
    const dx = (docs[x] as ShingledDoc).durationSec;
    const dy = (docs[y] as ShingledDoc).durationSec;
    if (dx !== dy) return dx > dy;
    return x < y;
  };
  const rep = new Map<number, number>();
  for (const [root, members] of clusters) {
    let best = members[0] as number;
    for (const m of members) if (better(m, best)) best = m;
    rep.set(root, best);
  }
  const repOf = (i: number) => rep.get(uf.find(i)) as number;

  // Clip edges between clusters: each clip cluster points at the longest source it is a clip of.
  const parent = new Map<number, { cluster: number; pair: Pair }>();
  for (const p of evaluated) {
    if (p.kind !== 'clip') continue;
    const ca = uf.find(p.a);
    const cb = uf.find(p.b);
    if (ca === cb) continue;
    const durA = (docs[repOf(p.a)] as ShingledDoc).durationSec;
    const durB = (docs[repOf(p.b)] as ShingledDoc).durationSec;
    if (!(durB > durA)) continue;
    const current = parent.get(ca);
    const curDur = current ? (docs[repOf(current.pair.b)] as ShingledDoc).durationSec : -1;
    if (!current || durB > curDur || (durB === curDur && p.al.overlapA > current.pair.al.overlapA)) parent.set(ca, { cluster: cb, pair: p });
  }
  const pathToRoot = (cluster: number): number[] => {
    const path = [cluster];
    let c = cluster;
    for (let next = parent.get(c); next; next = parent.get(c)) {
      c = next.cluster;
      path.push(c);
    }
    return path;
  };

  const isClip = (p: Pair) => p.kind === 'clip';
  const isReupload = (p: Pair) => p.kind === 'reupload';

  /** Clip evidence of video m against the original r: direct when the pair qualifies, else composed along the cluster path. */
  const clipEvidence = (m: number, r: number, path: number[]): GroupMember => {
    const videoId = (docs[m] as ShingledDoc).videoId;
    const direct = evaluate(m, r);
    if (isClip(direct) && direct.a === m) {
      return {
        videoId,
        offsetSec: round2(direct.al.offsetSec),
        coveredRange: roundRange(direct.al.coveredRangeB),
        evidence: { overlap: round3(direct.al.overlapA), matchedShingles: direct.al.matchedShingles, method: direct.method },
      };
    }
    // Compose: m -> its cluster rep -> each parent rep -> r.
    const hops: number[] = [m];
    for (const c of path) {
      const rp = rep.get(c) as number;
      if (hops[hops.length - 1] !== rp) hops.push(rp);
    }
    let offset = 0;
    let overlap = 1;
    let matched = Number.POSITIVE_INFINITY;
    let own: TimeRange | undefined;
    for (let h = 0; h + 1 < hops.length; h++) {
      const p = evaluate(hops[h] as number, hops[h + 1] as number);
      // offsetSec says where the pair's shorter video starts inside its longer one; flip it when this hop goes the other way.
      const sign = p.a === hops[h] ? 1 : -1;
      offset += sign * p.al.offsetSec;
      overlap = Math.min(overlap, p.al.overlapA);
      matched = Math.min(matched, p.al.matchedShingles);
      if (h === 0) own = matchedRangeOn(p, m, docs, o.shingleSize);
    }
    const rootDur = (docs[r] as ShingledDoc).durationSec;
    const range = own
      ? { startSec: Math.max(0, own.startSec + offset), endSec: Math.min(rootDur, own.endSec + offset) }
      : undefined;
    return {
      videoId,
      offsetSec: round2(offset),
      coveredRange: roundRange(range),
      evidence: { overlap: round3(overlap), matchedShingles: Number.isFinite(matched) ? matched : 0, method: 'composed' },
    };
  };

  /** Reupload evidence of m against r: direct when the pair qualifies, else the weakest link on a path of reupload edges. */
  const reuploadEvidence = (m: number, r: number): Evidence => {
    const direct = evaluate(m, r);
    if (isReupload(direct))
      return { overlap: round3(direct.al.overlapA), matchedShingles: direct.al.matchedShingles, method: direct.method };
    // Breadth-first path over reupload edges, neighbours in index order for determinism.
    const prev = new Map<number, number>([[r, -1]]);
    const queue = [r];
    while (queue.length > 0 && !prev.has(m)) {
      const u = queue.shift() as number;
      for (const v of [...(reuploadEdges.get(u) ?? [])].sort((x, y) => x - y)) {
        if (prev.has(v)) continue;
        prev.set(v, u);
        queue.push(v);
      }
    }
    let overlap = 1;
    let matched = Number.POSITIVE_INFINITY;
    for (let u = m; prev.get(u) !== undefined && prev.get(u) !== -1; u = prev.get(u) as number) {
      const p = evaluate(u, prev.get(u) as number);
      overlap = Math.min(overlap, p.al.overlapA);
      matched = Math.min(matched, p.al.matchedShingles);
    }
    return { overlap: round3(overlap), matchedShingles: Number.isFinite(matched) ? matched : 0, method: 'composed' };
  };

  const groupEvidence = (members: GroupMember[]): Evidence => {
    let weakest: Evidence | undefined;
    let method: EvidenceMethod = 'shingles';
    for (const m of members) {
      if (!m.evidence) continue;
      if (!weakest || m.evidence.overlap < weakest.overlap) weakest = m.evidence;
      if (METHOD_WEAKNESS[m.evidence.method] > METHOD_WEAKNESS[method]) method = m.evidence.method;
    }
    return { overlap: weakest?.overlap ?? 1, matchedShingles: weakest?.matchedShingles ?? 0, method };
  };

  const groups: { first: number; kindOrder: number; group: DuplicateGroup }[] = [];

  for (const [root, members] of clusters) {
    if (members.length < 2) continue;
    const r = rep.get(root) as number;
    const out: GroupMember[] = [{ videoId: (docs[r] as ShingledDoc).videoId }];
    for (const m of members) if (m !== r) out.push({ videoId: (docs[m] as ShingledDoc).videoId, evidence: reuploadEvidence(m, r) });
    groups.push({
      first: Math.min(...members),
      kindOrder: 0,
      group: { kind: 'reupload', members: out, original: (docs[r] as ShingledDoc).videoId, evidence: groupEvidence(out) },
    });
  }

  const clipsByRoot = new Map<number, number[]>();
  for (const cluster of clusters.keys()) {
    if (!parent.has(cluster)) continue;
    const path = pathToRoot(cluster);
    const root = path[path.length - 1] as number;
    const list = clipsByRoot.get(root);
    if (list) list.push(cluster);
    else clipsByRoot.set(root, [cluster]);
  }
  for (const [root, clipClusters] of clipsByRoot) {
    const r = rep.get(root) as number;
    const clipVideos: { index: number; path: number[] }[] = [];
    for (const c of clipClusters) {
      const path = pathToRoot(c);
      for (const m of clusters.get(c) as number[]) clipVideos.push({ index: m, path });
    }
    clipVideos.sort((x, y) => x.index - y.index);
    const out: GroupMember[] = [{ videoId: (docs[r] as ShingledDoc).videoId }];
    for (const v of clipVideos) out.push(clipEvidence(v.index, r, v.path));
    groups.push({
      first: Math.min(r, ...clipVideos.map((v) => v.index)),
      kindOrder: 1,
      group: { kind: 'clip', members: out, original: (docs[r] as ShingledDoc).videoId, evidence: groupEvidence(out) },
    });
  }
  groups.sort((x, y) => x.first - y.first || x.kindOrder - y.kindOrder);

  // Independence: each video counts as the original at the root of its clip path.
  for (let i = 0; i < docs.length; i++) {
    const path = pathToRoot(uf.find(i));
    representativeOf[(docs[i] as ShingledDoc).videoId] = (docs[rep.get(path[path.length - 1] as number) as number] as ShingledDoc)
      .videoId;
  }

  const related: RelatedPair[] = [];
  for (const p of evaluated) {
    if (p.kind !== 'related') continue;
    const da = docs[p.a] as ShingledDoc;
    const db = docs[p.b] as ShingledDoc;
    if (representativeOf[da.videoId] === representativeOf[db.videoId]) continue;
    const k = o.shingleSize;
    const spans = p.al.runs
      .filter((r) => runWords(r, k) >= o.relatedMinWords)
      .map((r) => ({
        a: rangeOf(da, r.aFrom, r.aTo + k - 1),
        b: rangeOf(db, r.bFrom, r.bTo + k - 1),
        words: runWords(r, k),
      }));
    // Report in input order: `a` is the earlier input.
    const swap = p.b < p.a;
    related.push({
      a: swap ? db.videoId : da.videoId,
      b: swap ? da.videoId : db.videoId,
      overlap: round3(p.al.overlapA),
      matchedShingles: p.al.matchedShingles,
      sharedSpans: swap ? spans.map((s) => ({ a: s.b, b: s.a, words: s.words })) : spans,
    });
  }
  related.sort((x, y) => (x