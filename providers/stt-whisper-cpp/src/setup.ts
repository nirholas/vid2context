/**
 * whisper.cpp setup: detect hardware, install the binary, download a verified
 * model, run a smoke transcription, and print the env lines to add to .env.
 *
 *   npx tsx providers/stt-whisper-cpp/src/setup.ts [--model <name>] [--lang en] [--force-cpu] [--server] [--from-source] [--force]
 *
 * The env lines go to stdout; progress goes to stderr. `setupWhisperCpp` is
 * the same flow as a function for the CLI's `setup` command.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { type Ctx, createContext, type Env, Vid2ContextError } from '@vid2context/core';
import { describeHardware, detectHardware, type Hardware } from './hardware.ts';
import { type BuildInfo, installWhisperCpp } from './install.ts';
import { downloadModel, recommendModel } from './models.ts';
import { modelsDir, resolveBinary } from './paths.ts';
import { stopManagedServers } from './server.ts';
import { transcribeWhisperCpp } from './whisper.ts';

export interface SetupOptions {
  /** Catalog name or path. Default: recommended for the hardware. */
  model?: string;
  /** Spoken language you mostly transcribe; 'en' picks English-only models on CPU. */
  language?: string;
  forceCpu?: boolean;
  /** Also smoke-test whisper-server and print WHISPER_CPP_SERVER=1. */
  server?: boolean;
  /** Build from source even where a prebuilt binary exists. */
  fromSource?: boolean;
  /** Reinstall the binary and re-download the model. */
  force?: boolean;
  /** Default true: transcribe the Apollo 11 clip when the repo fixture is present. */
  smoke?: boolean;
}

export interface SetupResult {
  hardware: Hardware;
  binary: { cli: string; server?: string; from: 'WHISPER_CPP_BIN' | 'PATH' | 'managed'; build?: BuildInfo };
  model: { name: string; path: string; sizeBytes: number; sha256?: string; reused: boolean };
  gpu: boolean;
  smoke?: { text: string; language: string; realtimeFactor: number; detail: string; server?: { text: string; detail: string } };
  notes: string[];
  /** Env vars to add to .env. */
  env: Record<string, string>;
}

/** The Apollo 11 clip shipped with the repo, when running from a checkout. */
export function smokeClipPath(): string | null {
  const p = fileURLToPath(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url));
  return existsSync(p) ? p : null;
}

export async function setupWhisperCpp(opts: SetupOptions, ctx: Ctx): Promise<SetupResult> {
  const notes: string[] = [];
  const hardware = await detectHardware({ env: ctx.env });
  ctx.log.info(`hardware: ${describeHardware(hardware)}`);

  let cli: string;
  let server: string | undefined;
  let from: SetupResult['binary']['from'];
  let build: BuildInfo | undefined;
  const existing = opts.force || opts.fromSource ? null : resolveBinary(ctx.env, 'whisper-cli');
  if (existing && existing.from !== 'managed') {
    cli = existing.path;
    from = existing.from;
    server = resolveBinary(ctx.env, 'whisper-server')?.path;
    notes.push(`Using whisper-cli from ${from}: ${cli}. Run with --force to install a managed build instead.`);
  } else {
    const inst = await installWhisperCpp(
      { hardware, forceCpu: opts.forceCpu, fromSource: opts.fromSource, force: opts.force },
      ctx,
    );
    cli = inst.cli;
    server = inst.server;
    from = 'managed';
    build = inst.build;
    notes.push(...inst.notes);
    ctx.log.info(
      `whisper.cpp ${inst.build.version} (${inst.build.source}, ${inst.build.backend}) ${inst.reused ? 'already installed' : 'installed'} in ${inst.dir}`,
    );
  }
  const gpu = build
    ? build.backend !== 'cpu'
    : !opts.forceCpu && hardware.gpu.vendor !== 'none' && (hardware.gpu.metal || hardware.gpu.cuda) === true;

  const modelName = opts.model ?? recommendModel(hardware, { language: opts.language, forceCpu: opts.forceCpu || !gpu });
  const model = await downloadModel(modelName, ctx, { force: opts.force });
  ctx.log.info(`model ${model.name}: ${model.path}${model.reused ? ' (already downloaded)' : ''}`);

  const inDefaultDir = dirname(model.path) === modelsDir(ctx.env) && basename(model.path) === `ggml-${model.name}.bin`;
  const env: Record<string, string> = {
    WHISPER_CPP_BIN: cli,
    WHISPER_CPP_MODEL: inDefaultDir ? model.name : model.path,
    WHISPER_CPP_GPU: gpu ? '1' : '0',
  };
  if (opts.server) {
    if (!server)
      throw new Vid2ContextError('unavailable', 'whisper-server was not found next to whisper-cli.', {
        hint: 'Rerun setup with --force to install a managed build that includes it.',
      });
    env.WHISPER_CPP_SERVER = '1';
  }

  let smoke: SetupResult['smoke'];
  const clip = opts.smoke === false ? null : smokeClipPath();
  if (clip) {
    const data = new Uint8Array(readFileSync(clip));
    const audio = { kind: 'bytes' as const, data, mimeType: 'audio/mpeg', filename: basename(clip) };
    const runEnv: Env = { ...ctx.env, ...env, WHISPER_CPP_MODEL: model.path, WHISPER_CPP_SERVER: '', WHISPER_CPP_SERVER_URL: '' };
    const r = await transcribeWhisperCpp(audio, { language: opts.language }, { ...ctx, env: runEnv });
    const text = r.segments.map((s) => s.text).join(' ');
    if (!text)
      throw new Vid2ContextError('upstream', 'The smoke transcription returned no text.', {
        hint: 'Try another model with --model, or rerun with --force.',
      });
    smoke = { text, language: r.language, realtimeFactor: r.realtimeFactor, detail: r.detail };
    ctx.log.info(`smoke test: "${text}" (${r.detail})`);
    if (opts.server) {
      try {
        const s = await transcribeWhisperCpp(
          audio,
          { language: opts.language },
          { ...ctx, env: { ...runEnv, WHISPER_CPP_SERVER: '1' } },
        );
        smoke.server = { text: s.segments.map((x) => x.text).join(' '), detail: s.detail };
        ctx.log.info(`server smoke test: ${s.detail}`);
      } finally {
        stopManagedServers();
      }
    }
  } else if (opts.smoke !== false) {
    notes.push(
      'Skipped the smoke transcription: tests/fixtures/media/apollo11-small-step.mp3 is not here (not running from a checkout).',
    );
  }

  return { hardware, binary: { cli, server, from, build }, model, gpu, smoke, notes, env };
}

export function envLines(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: 'string' },
      lang: { type: 'string' },
      'force-cpu': { type: 'boolean' },
      server: { type: 'boolean' },
      'from-source': { type: 'boolean' },
      force: { type: 'boolean' },
      'no-smoke': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.error(
      'usage: npx tsx providers/stt-whisper-cpp/src/setup.ts [--model <name>] [--lang en] [--force-cpu] [--server] [--from-source] [--force] [--no-smoke]',
    );
    return;
  }
  if (existsSync(join(process.cwd(), '.env'))) process.loadEnvFile(join(process.cwd(), '.env'));
  const env = { ...(process.env as Env), VID2CONTEXT_LOG_LEVEL: process.env.VID2CONTEXT_LOG_LEVEL ?? 'info' };
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  const ctx = createContext({ runtime: 'node', env, signal: ac.signal });
  try {
    const r = await setupWhisperCpp(
      {
        model: values.model,
        language: values.lang,
        forceCpu: values['force-cpu'],
        server: values.server,
        fromSource: values['from-source'],
        force: values.force,
        smoke: !values['no-smoke'],
      },
      ctx,
    );
    for (const n of r.notes) console.error(`note: ${n}`);
    console.error(`\nhardware: ${describeHardware(r.hardware)}`);
    if (r.smoke)
      console.error(
        `smoke test: "${r.smoke.text}"\n  ${r.smoke.detail}${r.smoke.server ? `\n  server: ${r.smoke.server.detail}` : ''}`,
      );
    console.error('\nAdd these lines to .env:\n');
    process.stdout.write(`${envLines(r.env).join('\n')}\n`);
  } catch (err) {
    const e = err as Vid2ContextError;
    console.error(`error: ${e.message}${e.hint ? `\nhint: ${e.hint}` : ''}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
