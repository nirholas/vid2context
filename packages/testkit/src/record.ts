#!/usr/bin/env -S npx tsx
/**
 * Record a real vid2context run into scrubbed fixture files, then replay them
 * to prove the fixtures reproduce the same transcript.
 *
 *   npm run record -- --out <dir> [--name <n>] -- <input> [--mode auto|captions|stt|video] [--lang xx] [--no-auto]
 *
 * stdout: what was recorded and the scrub report. stderr: logs.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  clearCooldowns,
  createContext,
  type Env,
  type GetContextOptions,
  getVideoContext,
  Registry,
  type TranscriptMode,
  type VideoContext,
} from '@vid2context/core';
import { replayFetch } from '@vid2context/core/testing';
import { loadRuntimeProviders } from './invariants.ts';
import { fixtureRoutes, recordingFetch } from './recorder.ts';

/**
 * The node registry, built package by package so one provider that is broken
 * or not installed yet is skipped with a warning instead of stopping the run.
 */
async function nodeRegistry(): Promise<Registry> {
  const { providers, failures } = await loadRuntimeProviders('node');
  for (const f of failures) console.error(`record: skipping ${f.pkg}: ${f.error}`);
  return new Registry(providers, 'node');
}

/** Same files as loadEnvFiles in @vid2context/registry/node: VID2CONTEXT_ENV_FILE, then ./.env. Shell variables win. */
function loadEnv(): void {
  const files = [process.env.VID2CONTEXT_ENV_FILE, '.env'].filter((p): p is string => Boolean(p)).map((p) => resolve(p));
  for (const f of new Set(files)) if (existsSync(f)) process.loadEnvFile(f);
}

const USAGE =
  'Usage: npm run record -- --out <dir> [--name <n>] -- <input> [--mode auto|captions|stt|video] [--lang xx] [--no-auto]';

interface Args {
  out: string;
  name?: string;
  input: string;
  opts: GetContextOptions;
}

function parse(argv: string[]): Args {
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const rest = sep === -1 ? [] : argv.slice(sep + 1);
  let out: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < own.length; i++) {
    if (own[i] === '--out') out = own[++i];
    else if (own[i] === '--name') name = own[++i];
    else throw new Error(`unknown option ${own[i]}\n${USAGE}`);
  }
  const opts: GetContextOptions = {};
  let input: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--mode') opts.mode = rest[++i] as TranscriptMode;
    else if (a === '--lang') opts.language = rest[++i];
    else if (a === '--no-auto') opts.allowAuto = false;
    else if (a?.startsWith('--')) throw new Error(`unknown pipeline option ${a}\n${USAGE}`);
    else if (input === undefined) input = a;
    else throw new Error(`unexpected argument ${a}\n${USAGE}`);
  }
  if (!out || !input) throw new Error(USAGE);
  return { out, name, input, opts };
}

function slug(input: string): string {
  return (
    input
      .replace(/^https?:\/\/(www\.)?/, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'rec'
  );
}

const transcriptOf = (c: VideoContext) => ({
  language: c.transcript.language,
  origin: c.transcript.origin,
  segments: c.transcript.segments,
});

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parse(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  loadEnv();
  const name = args.name ?? slug(args.input);
  const env = process.env as Env;
  const rec = recordingFetch(globalThis.fetch.bind(globalThis), { dir: args.out, name, scrub: { env } });
  const registry = await nodeRegistry();

  let live: VideoContext;
  try {
    live = await getVideoContext(registry, args.input, args.opts, createContext({ runtime: 'node', env, fetch: rec }));
  } catch (err) {
    console.error(`record: the live run failed: ${(err as Error).message}`);
    if (rec.files.length > 0) console.error(`record: ${rec.files.length} exchange(s) were still written to ${args.out}`);
    return 1;
  }
  return finish(args, name, env, registry, rec, live);
}

async function finish(
  args: Args,
  name: string,
  env: Env,
  rec: ReturnType<typeof recordingFetch>,
  live: VideoContext,
): Promise<number> {
  const out: string[] = [];
  out.push(`Recorded ${rec.files.length} exchange(s) into ${args.out}:`);
  for (const f of rec.files) out.push(`  ${f}`);

  const report = rec.report();
  out.push('', 'Scrubbed:');
  if (report.findings.length === 0) out.push('  nothing (no keys, tokens, cookies or stream IPs were present)');
  for (const f of report.findings) out.push(`  ${f.where}: ${f.what} x${f.count}`);
  for (const w of report.warnings) out.push(`  warning: ${w}`);

  // Replay the files just written through a fresh registry and ctx, and compare transcripts.
  clearCooldowns();
  const replay = replayFetch(fixtureRoutes(args.out, { name }));
  let same = false;
  try {
    const again = await getVideoContext(
      createRegistry(),
      args.input,
      args.opts,
      createContext({ runtime: 'node', env, fetch: replay }),
    );
    same = JSON.stringify(transcriptOf(again)) === JSON.stringify(transcriptOf(live));
    out.push(
      '',
      same ? 'Replay: the fixtures reproduce the same transcript.' : 'Replay: MISMATCH, the replayed transcript differs.',
    );
  } catch (err) {
    out.push('', `Replay: failed: ${(err as Error).message}`);
  }
  const contextFile = join(args.out, `${name}.context.json`);
  writeFileSync(contextFile, `${JSON.stringify(live, null, 2)}\n`);
  out.push(
    `Live VideoContext written to ${contextFile} (${live.transcript.segments.length} segments, ${live.transcript.origin}).`,
  );
  process.stdout.write(`${out.join('\n')}\n`);
  return same ? 0 : 1;
}

process.exitCode = await main();
