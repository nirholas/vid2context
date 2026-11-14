/**
 * Public types and default thresholds for duplicate, reupload and clip
 * detection. The reasoning behind each default is in README.md, with the
 * scores measured on the real fixtures.
 */

export type DuplicateKind = 'reupload' | 'clip';

export interface DedupeOptions {
  /** Words per shingle. Default 5. */
  shingleSize?: number;
  /** MinHash functions per signature. Default 128. */
  numHashes?: number;
  /** LSH bands; numHashes / bands rows per band. Default 64 (2 rows per band). */
  bands?: number;
  /** Seed for the MinHash functions. Same seed, same output. */
  seed?: number;
  /** Shingles per MinHash block; a window is two consecutive blocks (stride one block). Default 50. */
  blockShingles?: number;
  /** Largest gap, in shingles on either side, bridged inside one matched run. Default 12. */
  maxGap?: number;
  /** Matches a run needs before it counts as shared text. Default 3. */
  minRunMatches?: number;
  /** A shingle that occurs more often than this within one transcript is ignored as a stock phrase. Default 8. */
  maxOccurrences?: number;
  /** Covered share of the shorter transcript above which two uploads of similar length are one video. Default 0.8. */
  reuploadOverlap?: number;
  /** Largest relative duration difference for a reupload. Default 0.1 (10 percent). */
  durationTolerance?: number;
  /** Covered share of the shorter transcript, in time order, above which it is a clip of the longer one. Default 0.6. */
  clipOverlap?: number;
  /** Words a single shared run needs before a pair is reported as related. Default 25. */
  relatedMinWords?: number;
  /**
   * How far below a threshold a pair may score and still be promoted by
   * metadata (similar title or same channel). Default 0.05. Metadata never
   * classifies a pair on its own: the transcript must already be this close.
   */
  metadataMargin?: number;
  /** Title word Jaccard that counts as "similar title" for the metadata tie-breaker. Default 0.5. */
  titleSimilarity?: number;
  /** Fewer normalized words than this and a transcript is skipped as too short to judge. Default 12. */
  minWords?: number;
}

export const DEFAULTS: Required<DedupeOptions> = {
  shingleSize: 5,
  numHashes: 128,
  bands: 64,
  seed: 0x76326364,
  blockShingles: 50,
  maxGap: 12,
  minRunMatches: 3,
  maxOccurrences: 8,
  reuploadOverlap: 0.8,
  durationTolerance: 0.1,
  clipOverlap: 0.6,
  relatedMinWords: 25,
  metadataMargin: 0.05,
  titleSimilarity: 0.5,
  minWords: 12,
};

export interface TimeRange {
  startSec: number;
  endSec: number;
}

/** How a classification was reached. */
export type EvidenceMethod =
  /** Transcript alignment alone crossed the threshold. */
  | 'shingles'
  /** The transcript score was within `metadataMargin` of the threshold and title or channel tipped it. */
  | 'shingles+metadata'
  /** The member matched the original only through an intermediate video; offsets were added along the path. */
  | 'composed';

export interface Evidence {
  /** Covered share (0..1) of the shorter transcript, counting only text that appears in the other in time order. */
  overlap: number;
  /** Five-word shingles matched in time order. */
  matchedShingles: number;
  method: EvidenceMethod;
}

export interface GroupMember {
  videoId: string;
  /**
   * Clips only: where the clip starts inside the original, in seconds
   * (median of the time differences of matched shingles). A clip that starts
   * at 12:31 of the original has offsetSec 751. Negative when the clip has
   * material before the original's first matched words.
   */
  offsetSec?: number;
  /** Clips only: the span of the original the clip covers. */
  coveredRange?: TimeRange;
  /** This member against the group's original. Absent on the original itself. */
  evidence?: Evidence;
}

export interface DuplicateGroup {
  kind: DuplicateKind;
  /** The original first, then the others in input order. */
  members: GroupMember[];
  /** The likely original: for clips the long video; for reuploads the earliest published, see README. */
  original?: string;
  /** The weakest member link (lowest overlap, with its matched shingles) and the weakest method any member needed. */
  evidence: Evidence;
}

/** A pair that shares passages but is neither a reupload nor a clip (a compilation, a reaction, a shared intro). */
export interface RelatedPair {
  a: string;
  b: string;
  /** Covered share of the shorter transcript. */
  overlap: number;
  matchedShingles: number;
  sharedSpans: { a: TimeRange; b: TimeRange; words: number }[];
}

export interface DuplicatesResult {
  groups: DuplicateGroup[];
  related: RelatedPair[];
  /** Every input video id mapped to the id it counts as for independence (itself when it is in no group). */
  representativeOf: Record<string, string>;
  /** Videos too short to judge, or given twice. */
  skipped: { videoId: string; reason: 'too-short' | 'duplicate-input' }[];
  stats: { videos: number; windows: number; candidatePairs: number };
}
