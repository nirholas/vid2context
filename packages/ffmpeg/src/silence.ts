/**
 * The `ffmpeg-silence` audio splitter (AudioSplitter from core/audio-split.ts).
 *
 * One ffmpeg pass runs silencedetect and measures loudness in 100 ms windows.
 * Cuts land near `targetSec` at the closest silence, or, in noisy recordings
 * with no true silence, at the quietest moment nearby, so words are rarely
 * split. Each chunk is
 * re-encoded as constant-bitrate mp3 (16 kHz mono, 32 kbps by default), which
 * makes its size predictable: the chunk length is capped so every chunk stays
 * under `maxBytes`. Consecutive chunks overlap by `overlapSec` (default 2 s).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { type AudioChunk, type AudioInput, type AudioSplitter, type Ctx, type Env, Vid2ContextError } from '@vid2context/core';
import { AUDIO_MIME } from './audio.ts';
import { findTools, locateFfmpeg } from './locate.ts';
import { probeWith } from './probe.ts';
import { type FfCtx, runProcess } from './process.ts';

export interface Silence {
  startSec: number;
  endSec: number;
}

export interface PlannedChunk {
  startSec: number;
  endSec: number;
  overlapSec: number;
}

export interface SilenceSplitterOptions {
  /** mp3 bitrate of the chunks in kbps. Default 32. */
  bitrateKbps?: number;
  /** Level below which audio counts as silence. Default -35 (dB). */
  noiseDb?: number;
  /** Shortest silence that counts, in seconds. Default 0.3. */
  minSilenceSec?: number;
  /**
   * Env used only by the synchronous `canSplit` check to find ffmpeg. `split`
   * always uses `ctx.env`. Default: process.env (this package is Node only).
   */
  env?: Env;
}

const DEFAULT_OVERLAP = 2;
const MP3_SLACK_BYTES = 4096;

/** Parse silencedetect lines from ffmpeg's stderr. A trailing open silence ends at `durationSec`. */
export function parseSilences(lines: string[], durationSec?: number): Silence[] {
  const out: Silence[] = [];
  let open: number | undefined;
  for (const line of lines) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s?.[1]) {
      open = Math.max(0, Number(s[1]));
      continue;
    }
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e?.[1] && open !== undefined) {
      out.push({ startSec: open, endSec: Number(e[1]) });
      open = undefined;
    }
  }
  if (open !== undefined && durationSec !== undefined && durationSec > open) out.push({ startSec: open, endSec: durationSec });
  return out;
}

/** Loudness of one short window, from astats. */
export interface Level {
  atSec: number;
  /** RMS level in dB; -Infinity for digital silence. */
  rmsDb: number;
}

/** Window length of the loudness analysis, in seconds. */
export const LEVEL_WINDOW_SEC = 0.1;

/** Parse `ametadata` print output (pairs of "frame:... pts_time:T" and "...RMS_level=V" lines). */
export function parseLevels(text: string): Level[] {
  const out: Level[] = [];
  let at: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    const t = /pts_time:\s*(-?[\d.]+)/.exec(line);
    if (t?.[1]) {
      at = Number(t[1]);
      continue;
    }
    const v = /RMS_level=(\S+)/.exec(line);
    if (v?.[1] && at !== undefined) {
      const db = v[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(v[1]);
      if (!Number.isNaN(db)) out.push({ atSec: at, rmsDb: db });
      at = undefined;
    }
  }
  return out;
}

/**
 * Choose cut points. Every chunk is at most `maxChunkSec` long including its
 * overlap. Each cut lands on the silence midpoint nearest `targetSec` after the
 * previous cut; when no silence is in range (noisy recordings), on the quietest
 * loudness window near that point; with neither, exactly there.
 */
export function planCuts(
  durationSec: number,
  silences: Silence[],
  opts: { maxChunkSec: number; targetSec?: number; overlapSec?: number; levels?: Level[] },
): PlannedChunk[] {
  const overlap = Math.max(0, opts.overlapSec ?? DEFAULT_OVERLAP);
  const maxChunk = opts.maxChunkSec;
  if (maxChunk <= overlap + 1) {
    throw new Vid2ContextError(
      'bad-request',
      `A chunk can be at most ${maxChunk.toFixed(1)} s, too short for a ${overlap} s overlap.`,
      {
        hint: 'Raise maxBytes or lower overlapSec.',
      },
    );
  }
  const mids = silences.map((s) => (s.startSec + s.endSec) / 2).filter((m) => m > 0 && m < durationSec);
  const levels = opts.levels ?? [];
  const chunks: PlannedChunk[] = [];
  let cut = 0;
  for (;;) {
    const lead = chunks.length === 0 ? 0 : Math.min(overlap, cut);
    const room = maxChunk - lead;
    const span = Math.min(opts.targetSec ?? room, room);
    const remaining = durationSec - cut;
    if (remaining <= room && remaining <= span * 1.3) {
      chunks.push({ startSec: cut - lead, endSec: durationSec, overlapSec: lead });
      return chunks;
    }
    const ideal = cut + span;
    const lo = cut + span * 0.5;
    const hi = Math.min(cut + room, durationSec - 0.5);
    let next = Math.min(ideal, hi);
    let best = Number.POSITIVE_INFINITY;
    for (const m of mids) {
      if (m <= lo || m > hi) continue;
      const d = Math.abs(m - ideal);
      if (d < best) {
        best = d;
        next = m;
      }
    }
    if (best === Number.POSITIVE_INFINITY) {
      // No silence in range: take the quietest window within a quarter span of the ideal point.
      const from = Math.max(lo, ideal - span * 0.25);
      const to = Math.min(hi, ideal + span * 0.25);
      let quietest = Number.POSITIVE_INFINITY;
      for (const l of levels) {
        const mid = l.atSec + LEVEL_WINDOW_SEC / 2;
        if (mid <= from || mid > to) continue;
        if (l.rmsDb < quietest || (l.rmsDb === quietest && Math.abs(mid - ideal) < Math.abs(next - ideal))) {
          quietest = l.rmsDb;
          next = mid;
        }
      }
    }
    chunks.push({ startSec: cut - lead, endSec: next, overlapSec: lead });
    cut = next;
  }
}

export interface AudioAnalysis {
  silences: Silence[];
  levels: Level[];
}

/** One ffmpeg pass: silencedetect plus the RMS level of every 100 ms window. */
export async function analyzeAudio(
  input: string,
  ctx: FfCtx = {},
  opts: { noiseDb?: number; minSilenceSec?: number; durationSec?: number; timeoutMs?: number } = {},
): Promise<AudioAnalysis> {
  const tools = await locateFfmpeg(ctx, { download: false });
  const lines: string[] = [];
  const windowSamples = Math.round(16_000 * LEVEL_WINDOW_SEC);
  const filter = [
    'aresample=16000',
    `silencedetect=noise=${opts.noiseDb ?? -35}dB:d=${opts.minSilenceSec ?? 0.3}`,
    `asetnsamples=n=${windowSamples}:p=0`,
    'astats=metadata=1:reset=1',
    'ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
  ].join(',');
  const res = await runProcess(
    tools.ffmpeg,
    ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-i', input, '-map', '0:a:0', '-af', filter, '-f', 'null', '-'],
    {
      label: 'ffmpeg silencedetect',
      signal: ctx.signal,
      captureStdout: true,
      maxStdoutBytes: 256 * 1024 * 1024,
      timeoutMs: opts.timeoutMs ?? 30 * 60_000,
      onStderrLine: (line) => {
        if (line.includes('silence_')) lines.push(line);
      },
    },
  );
  return { silences: parseSilences(lines, opts.durationSec), levels: parseLevels(new TextDecoder().decode(res.stdout)) };
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/webm': '.webm',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

function inputExt(audio: Extract<AudioInput, { kind: 'bytes' }>): string {
  const fromName = extname(audio.filename).toLowerCase();
  if (/^\.[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  return EXT_BY_MIME[audio.mimeType.split(';')[0]?.trim().toLowerCase() ?? ''] ?? '.bin';
}

/** Create an ffmpeg silence splitter with custom settings. */
export function createSilenceSplitter(settings: SilenceSplitterOptions = {}): AudioSplitter {
  const bitrate = settings.bitrateKbps ?? 32;
  const bytesPerSec = (bitrate * 1000) / 8;
  return {
    id: 'ffmpeg-silence',
    canSplit(audio: AudioInput): boolean {
      if (audio.kind !== 'bytes') return false;
      const found = findTools(settings.env ?? process.env);
      return Boolean(found.ffmpeg && found.ffprobe && !found.problem);
    },
    async *split(audio: AudioInput, opts, ctx: Ctx): AsyncIterable<AudioChunk> {
      if (audio.kind !== 'bytes') {
        throw new Vid2ContextError('bad-request', 'The ffmpeg splitter needs audio bytes, not a URL.', {
          hint: 'Download the audio first.',
        });
      }
      const maxChunkSec = (opts.maxBytes * 0.97 - MP3_SLACK_BYTES) / bytesPerSec;
      const tools = await locateFfmpeg(ctx, { download: true });
      const stem = audio.filename.slice(0, audio.filename.length - extname(audio.filename).length) || 'audio';
      const dir = await mkdtemp(join(tmpdir(), 'vid2context-split-'));
      try {
        const src = join(dir, `input${inputExt(audio)}`);
        await writeFile(src, audio.data);
        const info = await probeWith(tools.ffprobe, src, ctx);
        const durationSec = info.durationSec;
        if (!durationSec) {
          throw new Vid2ContextError('unavailable', 'Could not read the audio duration, so it cannot be split.', {
            hint: 'Check that the audio is a complete, playable file.',
          });
        }
        const { silences, levels } = await analyzeAudio(src, ctx, {
          noiseDb: settings.noiseDb,
          minSilenceSec: settings.minSilenceSec,
          durationSec,
        });
        const plan = planCuts(durationSec, silences, {
          maxChunkSec,
          targetSec: opts.targetSec,
          overlapSec: opts.overlapSec,
          levels,
        });
        for (const [index, p] of plan.entries()) {
          const out = join(dir, `chunk-${index}.mp3`);
          const length = p.endSec - p.startSec;
          // -ss before -i seeks fast; with re-encoding ffmpeg still cuts sample-accurately.
          const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', p.startSec.toFixed(3), '-i', src];
          args.push('-t', length.toFixed(3), '-map', '0:a:0', '-vn', '-map_metadata', '-1');
          args.push('-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, out);
          await runProcess(tools.ffmpeg, args, { label: 'ffmpeg chunk encode', signal: ctx.signal, timeoutMs: 30 * 60_000 });
          const data = new Uint8Array(await readFile(out));
          await rm(out, { force: true });
          if (data.byteLength > opts.maxBytes) {
            throw new Vid2ContextError('upstream', `Chunk ${index} is ${data.byteLength} bytes, over ${opts.maxBytes}.`, {
              hint: 'Lower targetSec or raise maxBytes.',
            });
          }
          yield {
            index,
            startSec: p.startSec,
            durationSec: length,
            overlapSec: p.overlapSec,
            audio: {
              kind: 'bytes',
              data,
              mimeType: AUDIO_MIME.mp3,
              filename: `${stem}.part${String(index + 1).padStart(3, '0')}.mp3`,
              durationSec: length,
            },
          };
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The default ffmpeg silence splitter (id 'ffmpeg-silence'). */
export const splitOnSilence: AudioSplitter = createSilenceSplitter();
