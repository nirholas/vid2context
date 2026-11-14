/**
 * Audio splitting contract shared by the long-audio orchestrator
 * (core/src/longform) and media tooling (packages/ffmpeg). A splitter cuts
 * audio that is too large for any speech-to-text rung into chunks that fit,
 * preferably at silences, with a small overlap so words on a cut are not lost.
 *
 * Created verbatim from docs/prompts/SHARED-CONTRACTS.md. Change it only
 * additively, and update that file in the same commit.
 */
import type { AudioInput, Ctx } from './types.ts';

export type AudioBytes = Extract<AudioInput, { kind: 'bytes' }>;

export interface AudioChunk {
  /** 0-based position in the original audio. */
  index: number;
  /** Where this chunk starts in the original audio, in seconds (including its overlap). */
  startSec: number;
  durationSec: number;
  /** Seconds at the start of this chunk that repeat the end of the previous chunk. 0 for the first chunk. */
  overlapSec: number;
  audio: AudioBytes;
}

export interface SplitOptions {
  /** Every chunk's byte length must be at most this. */
  maxBytes: number;
  /** Preferred chunk length in seconds. Splitters that can detect silence cut near this point. */
  targetSec?: number;
  /** Overlap between consecutive chunks in seconds. Default chosen by the splitter (about 2s). */
  overlapSec?: number;
}

export interface AudioSplitter {
  /** Stable id for attempts and logs: 'mp3-frames', 'wav-pcm', 'ffmpeg-silence'. */
  id: string;
  /** Synchronous and cheap: true when this splitter handles this input's container in this runtime. */
  canSplit(audio: AudioInput): boolean;
  split(audio: AudioInput, opts: SplitOptions, ctx: Ctx): AsyncIterable<AudioChunk>;
}
