/**
 * Transcription through whisper.cpp. The input is converted to 16 kHz mono
 * 16-bit WAV with ffmpeg, then either run through `whisper-cli` (one-shot,
 * JSON output) or posted to a whisper-server's /inference endpoint (server
 * mode, model stays loaded). Temp files are always deleted.
 */
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  type AudioInput,
  type Ctx,
  type Env,
  errorFromResponse,
  fetchWithTimeout,
  type Segment,
  type SttOptions,
  type SttResult,
  Vid2ContextError,
} from '@vid2context/core';
import { normalizeLanguage } from '@vid2context/provider-stt-openai-compatible';
import { run, SpawnError } from './exec.ts';
import { isEnglishOnly, resolveModel } from './models.ts';
import { isFile, resolveBinary, resolveFfmpeg } from './paths.ts';
import { inferViaServer, managedServerUrl } from './server.ts';

/** SttOptions plus whisper's built-in translate-to-English. */
export interface WhisperCppOptions extends SttOptions {
  translate?: boolean;
}

/** The result, plus a one-line `detail` with the realtime factor for the attempt log. */
export interface WhisperCppResult extends SttResult {
  detail: string;
  realtimeFactor: number;
  audioSec: number;
  wallSec: number;
}

export interface WhisperCppConfig {
  model: string;
  threads: number;
  gpu: boolean;
  serverUrl?: string;
  managedServer: boolean;
}

export function defaultThreads(): number {
  return Math.max(1, Math.min(availableParallelism(), 8));
}

/** Read the whisper.cpp settings from env. Throws when WHISPER_CPP_MODEL is missing. */
export function readConfig(env: Env): WhisperCppConfig {
  const model = env.WHISPER_CPP_MODEL?.trim();
  if (!model) {
    throw new Vid2ContextError('unavailable', 'WHISPER_CPP_MODEL is not set.', {
      hint: 'Run `npx tsx providers/stt-whisper-cpp/src/setup.ts` and add the lines it prints to .env.',
    });
  }
  const t = Number(env.WHISPER_CPP_THREADS);
  return {
    model,
    threads: Number.isInteger(t) && t > 0 ? t : defaultThreads(),
    gpu: isTruthy(env.WHISPER_CPP_GPU),
    serverUrl: env.WHISPER_CPP_SERVER_URL?.trim() || undefined,
    managedServer: isTruthy(env.WHISPER_CPP_SERVER),
  };
}

export function isTruthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(v?.trim() ?? '');
}

/** BCP-47 to the base code whisper takes ('en-US' -> 'en'); undefined for auto. */
export function whisperLanguage(language: string | undefined): string | undefined {
  const base = language?.split(/[-_]/)[0]?.trim().toLowerCase();
  return base && base !== 'auto' ? base : undefined;
}

export interface CliArgs {
  model: string;
  wav: string;
  outBase: string;
  threads: number;
  language?: string;
  prompt?: string;
  translate?: boolean;
  englishOnly?: boolean;
}

export function buildCliArgs(a: CliArgs): string[] {
  const args = ['-m', a.model, '-f', a.wav, '-oj', '-of', a.outBase, '-t', String(a.threads), '-np'];
  args.push('-l', a.language ?? (a.englishOnly ? 'en' : 'auto'));
  if (a.prompt) args.push('--prompt', a.prompt);
  if (a.translate && !a.englishOnly) args.push('-tr');
  return args;
}

interface CliJson {
  result?: { language?: string };
  params?: { language?: string; translate?: boolean };
  transcription?: { offsets?: { from?: number; to?: number }; text?: string }[];
}

/** Parse whisper-cli's `-oj` output: `offsets` are milliseconds. */
export function parseCliJson(json: unknown, fallbackLanguage?: string): { language: string; segments: Segment[] } {
  const j = (json ?? {}) as CliJson;
  const segments: Segment[] = [];
  for (const t of j.transcription ?? []) {
    const text = (t.text ?? '').trim();
    if (!text) continue;
    segments.push({ startSec: (t.offsets?.from ?? 0) / 1000, endSec: (t.offsets?.to ?? 0) / 1000, text });
  }
  const detected = j.result?.language;
  const language = j.params?.translate ? 'en' : (normalizeLanguage(detected) ?? fallbackLanguage ?? 'und');
  return { language, segments };
}

/** Duration of a PCM WAV file from its header: data bytes / byte rate. */
export function wavDurationSec(header: Uint8Array): number | undefined {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const tag = (o: number) => String.fromCharCode(...header.subarray(o, o + 4));
  if (header.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let byteRate = 0;
  let off = 12;
  while (off + 8 <= header.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ' && off + 20 <= header.byteLength) byteRate = view.getUint32(off + 16, true);
    if (id === 'data') return byteRate > 0 ? size / byteRate : undefined;
    off += 8 + size + (size % 2);
  }
  return undefined;
}

/** Map whisper-cli's stderr and exit status to a user-facing error. */
export function cliError(stderr: string, code: number | null, signal: string | null, modelPath: string): Vid2ContextError {
  const tailText = stderr.trim().split('\n').slice(-6).join('\n');
  if (/model file not found|failed to load model|failed to open .*model|invalid model/i.test(stderr)) {
    return new Vid2ContextError('unavailable', `whisper.cpp could not load the model ${modelPath}: ${tailText}`, {
      hint: 'Run `npx tsx providers/stt-whisper-cpp/src/setup.ts --model <name>` to download it, or point WHISPER_CPP_MODEL at an existing ggml .bin file.',
    });
  }
  if (/out of memory|failed to allocate|cudaMalloc|ErrorOutOfDeviceMemory|bad_alloc/i.test(stderr) || signal === 'SIGKILL') {
    return new Vid2ContextError('unavailable', `whisper.cpp ran out of memory: ${tailText || `killed by ${signal}`}`, {
      hint: 'Use a smaller or quantized model (for example large-v3-turbo-q5_0, small or base), or close other GPU programs.',
    });
  }
  if (/failed to read audio|failed to decode|read_audio_data: failed/i.test(stderr)) {
    return new Vid2ContextError('upstream', `whisper.cpp could not read the audio: ${tailText}`, {
      hint: 'The converted WAV was unreadable. Check that ffmpeg can decode the input: ffmpeg -i <file> -f null -',
    });
  }
  return new Vid2ContextError('upstream', `whisper-cli failed (exit ${code ?? signal}): ${tailText}`, {
    hint: 'Run whisper-cli by hand with the same model to see the full error, or rerun setup with --force to reinstall.',
  });
}

async function materialize(audio: AudioInput, dir: string, ctx: Ctx): Promise<string> {
  if (audio.kind === 'bytes') {
    const ext = extname(audio.filename || '') || '.bin';
    const p = join(dir, `input${ext}`);
    await writeFile(p, audio.data);
    return p;
  }
  const res = await fetchWithTimeout(ctx, audio.url, { redirect: 'follow' }, 30 * 60_000);
  if (!res.ok) throw await errorFromResponse(res, 'Audio download for whisper.cpp');
  const p = join(dir, 'input.media');
  await writeFile(p, new Uint8Array(await res.arrayBuffer()));
  return p;
}

/** Convert any input ffmpeg can read to 16 kHz mono 16-bit WAV. Returns the duration from the WAV header. */
export async function toWav(input: string, wav: string, ctx: Ctx): Promise<number> {
  const ffmpeg = resolveFfmpeg(ctx.env);
  if (!ffmpeg) {
    throw new Vid2ContextError('unavailable', 'ffmpeg is needed to prepare audio for whisper.cpp and was not found.', {
      hint: 'Install ffmpeg (or set FFMPEG_PATH to its path).',
    });
  }
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = await run(
      ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input,
        '-vn',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        wav,
      ],
      {
        timeoutMs: 20 * 60_000,
        signal: ctx.signal,
        env: ctx.env,
      },
    );
  } catch (err) {
    if (err instanceof SpawnError) {
      throw new Vid2ContextError('unavailable', `Cannot run ffmpeg at ${ffmpeg} (${err.errno}).`, {
        hint: 'Install ffmpeg or fix FFMPEG_PATH.',
        cause: err,
      });
    }
    throw err;
  }
  if (r.timedOut)
    throw new Vid2ContextError('timeout', 'ffmpeg timed out converting the audio.', { hint: 'Try a shorter file.' });
  if (r.code !== 0) {
    throw new Vid2ContextError('upstream', `ffmpeg could not decode the audio: ${r.stderr.trim().slice(-500)}`, {
      hint: 'The file may be corrupt or have no audio track. Check it with: ffmpeg -i <file>',
    });
  }
  const fh = await open(wav, 'r');
  try {
    const head = new Uint8Array(4096);
    const { bytesRead } = await fh.read(head, 0, head.byteLength, 0);
    return wavDurationSec(head.subarray(0, bytesRead)) ?? 0;
  } finally {
    await fh.close();
  }
}

/** Wall-clock budget for one transcription: a minute for model loading plus ten times the audio length. */
export function timeoutFor(audioSec: number): number {
  return 60_000 + Math.ceil(audioSec * 10_000);
}

export function realtimeDetail(audioSec: number, wallSec: number, model: string, mode: string, threads: number): string {
  const rtf = wallSec > 0 ? audioSec / wallSec : 0;
  return `${rtf.toFixed(1)}x realtime (${audioSec.toFixed(1)} s audio in ${wallSec.toFixed(2)} s), model ${model}, ${mode}, ${threads} threads`;
}

/** Transcribe with whisper.cpp using the settings in ctx.env. */
export async function transcribeWhisperCpp(audio: AudioInput, opts: WhisperCppOptions, ctx: Ctx): Promise<WhisperCppResult> {
  const cfg = readConfig(ctx.env);
  const model = resolveModel(cfg.model, ctx.env);
  const englishOnly = isEnglishOnly(model.name);
  const language = whisperLanguage(opts.language);
  if (englishOnly && language && language !== 'en') {
    throw new Vid2ContextError('unavailable', `The English-only model ${model.name} cannot transcribe ${language}.`, {
      hint: 'Set WHISPER_CPP_MODEL to a multilingual model (a name without .en, such as small or large-v3-turbo).',
    });
  }
  if (!cfg.serverUrl && !isFile(model.path)) {
    throw new Vid2ContextError('unavailable', `whisper.cpp model not found: ${model.path}`, {
      hint: model.known
        ? `Run \`npx tsx providers/stt-whisper-cpp/src/setup.ts --model ${model.name}\` to download it.`
        : 'Point WHISPER_CPP_MODEL at an existing ggml .bin file, or use a catalog name such as base.en.',
    });
  }

  const dir = await mkdtemp(join(tmpdir(), 'vid2context-whisper-'));
  try {
    const input = await materialize(audio, dir, ctx);
    const wav = join(dir, 'audio.wav');
    const audioSec = (await toWav(input, wav, ctx)) || audio.durationSec || 0;
    const timeoutMs = timeoutFor(audioSec);

    if (cfg.serverUrl || cfg.managedServer) {
      const url = cfg.serverUrl ?? (await managedServerUrl(model.path, cfg.threads, ctx));
      const started = Date.now();
      const parsed = await inferViaServer(
        url,
        wav,
        { language, prompt: opts.prompt, translate: opts.translate && !englishOnly },
        ctx,
        timeoutMs,
      );
      const wallSec = (Date.now() - started) / 1000;
      return finish(parsed, model.name, audioSec, wallSec, cfg.serverUrl ? 'server' : 'managed server', cfg.threads, ctx);
    }

    const bin = resolveBinary(ctx.env, 'whisper-cli');
    if (!bin) {
      throw new Vid2ContextError('unavailable', 'whisper-cli was not found (WHISPER_CPP_BIN, PATH, or the managed install).', {
        hint: 'Run `npx tsx providers/stt-whisper-cpp/src/setup.ts` to install it, or set WHISPER_CPP_BIN.',
      });
    }
    const outBase = join(dir, 'out');
    const args = buildCliArgs({
      model: model.path,
      wav,
      outBase,
      threads: cfg.threads,
      language,
      prompt: opts.prompt,
      translate: opts.translate,
      englishOnly,
    });
    const started = Date.now();
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run(bin.path, args, { timeoutMs, signal: ctx.signal, env: ctx.env });
    } catch (err) {
      if (err instanceof SpawnError) {
        throw new Vid2ContextError('unavailable', `Cannot run whisper-cli at ${bin.path} (${err.errno}).`, {
          hint:
            bin.from === 'WHISPER_CPP_BIN'
              ? 'Fix WHISPER_CPP_BIN, or unset it to use the managed install.'
              : 'Rerun setup with --force to reinstall.',
          cause: err,
        });
      }
      throw err;
    }
    const wallSec = (Date.now() - started) / 1000;
    if (r.timedOut) {
      throw new Vid2ContextError('timeout', `whisper-cli did not finish within ${Math.round(timeoutMs / 1000)} s.`, {
        hint: 'Use a smaller model, or a GPU build (rerun setup on a machine with an NVIDIA GPU or Apple Silicon).',
      });
    }
    if (r.code !== 0) throw cliError(r.stderr, r.code, r.signal, model.path);
    let json: unknown;
    try {
      json = JSON.parse(await readFile(`${outBase}.json`, 'utf8'));
    } catch (err) {
      throw new Vid2ContextError('upstream', `whisper-cli wrote no readable JSON: ${r.stderr.trim().slice(-300)}`, {
        hint: 'Your whisper.cpp may be too old for -oj; rerun setup with --force.',
        cause: err,
      });
    }
    return finish(parseCliJson(json, language), model.name, audioSec, wallSec, 'cli', cfg.threads, ctx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function finish(
  parsed: { language: string; segments: Segment[] },
  model: string,
  audioSec: number,
  wallSec: number,
  mode: string,
  threads: number,
  ctx: Ctx,
): WhisperCppResult {
  const detail = realtimeDetail(audioSec, wallSec, model, mode, threads);
  ctx.log.info(`whisper.cpp: ${detail}`);
  return {
    language: parsed.language,
    segments: parsed.segments,
    model,
    detail,
    realtimeFactor: wallSec > 0 ? audioSec / wallSec : 0,
    audioSec,
    wallSec,
  };
}
