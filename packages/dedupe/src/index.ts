export { type Alignment, type AlignOptions, align, type Run } from './align.ts';
export { findDuplicates, independentSources, titleSimilarity } from './dedupe.ts';
export {
  annotate,
  type DuplicatesReport,
  type DuplicatesRequest,
  duplicatesReport,
  type LoadFailure,
  loadContexts,
  MAX_VIDEOS,
  type VideoInfo,
} from './load.ts';
export { candidatePairs, hashSeeds, windowSignatures } from './minhash.ts';
export { FILLERS, normalizeWords, numberWordsToDigits } from './normalize.ts';
export { resolveOptions } from './options.ts';
export { durationOf, type ShingledDoc, shingle } from './shingles.ts';
export * from './types.ts';
