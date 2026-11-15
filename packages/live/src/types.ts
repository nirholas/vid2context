import type { AudioInput, ChainOptions, Ctx, Registry, Segment, Transcript } from '@vid2context/core';

/** The bytes of consecutive media segments plus the span to cut out of them. */
export interface ChunkMedia {
  /** Init section (if any) followed by the segments, as served. */
  data: Uint8Array;
  /** Where the chunk starts, in seconds from the start of `data`. */
  offsetSec: number;
  durationSec: number;
  /** Upload filename for the extracted audio, e.g. `live-123456.wav`. */
  filename: string;
}

/** Turns media segments into speech-to-text-ready audio. The Node implementation is `createFfmpegExtractor` (`@vid2context/live/node`). */
export interface AudioExtractor {
  id: string;
  extract(media: ChunkMedia, signal?: AbortSignal): Promise<Extract<AudioInput, { kind: 'bytes' }>>;
}

export interface WatchLiveOptions {
  /** Stop after this many minutes of watching (wall clock). Default: until the stream ends. */
  maxMinutes?: number;
  /** Seconds of audio per speech-to-text request. Default 30. */
  chunkSec?: number;
  /** Seconds each chunk repeats from the end of the previous one, so words on a cut are not lost. Default 2. */
  overlapSec?: number;
  /** When transcription falls this many seconds behind the live edge, skip ahead. Default 120. */
  maxLagSec?: number;
  /**
   * When transcription is behind by two chunks or more, the next request takes up to this many chunks of audio at once,
   * so a rate-limited rung needs fewer requests to catch up before maxLagSec forces a skip. A merged request
   * never exceeds 60 s of audio including the overlap (the keyless OVH limit), or one chunk if chunkSec is longer. Default 3; 1 never merges.
   */
  catchUpChunks?: number;
  /** Spoken language (BCP-47) passed to speech-to-text; also picks the audio rendition when a stream offers several. */
  language?: string;
  signal?: AbortSignal;
  /** Resume after a restart: the first media sequence to transcribe (the `resumeSequence` of the last event you saw). */
  fromSequence?: number;
  /** Rung chain options for speech-to-text (policy, only, skip). */
  chain?: ChainOptions;
}

export interface LiveDeps {
  registry: Registry;
  ctx: Ctx;
  /** Required: live chunks are cut with ffmpeg, which only runs on Node. Use `createFfmpegExtractor({ env: ctx.env })`. */
  extractAudio?: AudioExtractor;
  /** Waits between playlist polls and retries. Defaults to a timer that the abort signal cancels. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type LiveEvent =
  | {
      type: 'segment';
      /** Times are stream time: seconds on the stream's own timeline (on YouTube, since the broadcast began). */
      segment: Segment;
      /** Wall-clock time of `segment.startSec` (ISO 8601) when the stream carries EXT-X-PROGRAM-DATE-TIME. */
      at?: string;
      /** Pass as `fromSequence` to resume after this point. */
      resumeSequence: number;
    }
  | {
      type: 'status';
      message: string;
      /** Machine-readable kind of status. */
      code: LiveStatusCode;
      resumeSequence?: number;
    }
  | {
      type: 'done';
      transcript: Transcript;
      /** Why watching stopped. */
      reason: 'ended' | 'max-minutes' | 'cancelled' | 'lost';
      resumeSequence?: number;
    };

export type LiveStatusCode =
  | 'started'
  | 'rung'
  | 'keyless-only'
  | 'stt-retry'
  | 'skipped'
  | 'missed'
  | 'resume-gap'
  | 'playlist-error'
  | 'refreshed'
  | 'ended'
  | 'stopping';
