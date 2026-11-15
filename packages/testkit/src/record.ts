#!/usr/bin/env -S npx tsx
/**
 * Record a real vid2context run into scrubbed fixture files, then replay them
 * to prove the fixtures reproduce the same transcript.
 *
 *   npm run record -- --out <dir> [--name <n>] [--allow-subprocess] -- <input> [--mode auto|captions|stt|video] [--lang xx] [--no-auto]
 *
 * stdout: what was recorded and the scrub report. stderr: logs.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createContext,
  type Env,
  type GetContextOptions,
  getVideoContext,
  Registry,
  type TranscriptMode,
  type VideoContext,
} from '@vid2context/core';
import { replayFetch } from '@vid2context/core/testing';
import { loadRuntimeProviders, providerPackages, reachableFiles, runtimeEntry, stripComments } from './invariants.ts';
import { fixtureRoutes, recordingFetch } from './recorder.ts';

/**
 * Provider packages whose node entry reaches child_process (yt-dlp, local
 * whisper builds). Their network traffic, if any, never passes through
 * ctx.fetch, so a recording cannot capture it and a replay would quietly run
 * them for real again.
 */
function subprocessPackages(): Set<string> {
  const out = new Set<string>();
  for (const pkg of providerPackages()) {
    const entry = runtimeEntry(pkg.dir, 'node');
    if (!entry) continue;
    const spawns = reachableFiles(entry).some((f) =>
      /\b(?:from|import)\s*\(?\s*['"](?:node:)?child_process['"]/.test(stripComments(readFileSync(f, 'utf8'))),
    );
    if (spawns) out.add(pkg.name);
  }
  return out;
}

/**
 * The node registry, built package by package so one provider that is broken
 * or not installed yet is skipped with a warning instead of stopping the run.
 * Unless allowSubprocess is set, providers that spawn processes are left out
 * (see subprocessPackages), so every byte the pipeline used is in the fixtures.
 */
async function nodeRegistry(allowSubprocess: boolean, quiet = false): Promise<{ registry: Registry; excluded: string[] }> {
  const { providers, origins, failures } = await loadRuntimeProviders('node');
  if (!quiet) for (const f of failures) console.error(`record: skipping ${f.pkg}: ${f.error}`);
  const spawning = allowSubprocess ? new Set<string>() : subprocessPackages();
  const kept = providers.filter((p) => !spawning.has(origins.get(p.id) ?? ''));
  const excluded = providers.filter((p) => !kept.includes(p)).map((p) => p.id);
  return { registry: new Registry(kept, 'node'), excluded };
}

/** Same files as loadEnvFiles in @vid2context/registry/node: VID2CONTEXT_ENV_FILE, then ./.env. Shell variables win. */
function loadEnv(): void {
  const files = [process.env.VID2CONTEXT_ENV_FILE, '.env'].filter((p): p is string => Boolean(p)).map((p) => resolve(p));
  for (const f of new Set(files)) if (existsSync(f)) process.loadEnvFile(f);
}

const USAGE =
  'Usage: npm run record -- --out <dir> [--name <n>] [--allow-subprocess] -- <input> [--mode auto|captions|stt|video] [--lang xx] [--no-auto]';

interface Args {
  out: string;
  /** Internal: replay `out` instead of recording (used by the verification child process). */
  replay?: boolean;
  name?: string;
  /** Keep providers that spawn processes (yt-dlp): their traffic is not recorded, so replay is not verified. */
  allowSubprocess: boolean;
  input: string;
  opts: GetContextOptions;
}

function parse(argv: string[]): Args {
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const rest = sep === -1 ? [] : argv.slice(sep + 1);
  let out: string | undefined;
  let name: string | undefined;
  let replay = false;
  let allowSubprocess = false;
  for (let i = 0; i < own.length; i++) {
    if (own[i] === '--replay') replay = true;
    else if (own[i] === '--allow-subprocess') allowSubprocess = true;
    else if (own[i] === '--out') out = own[++i];
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
  return { out, name, input, opts, replay, allowSubprocess };
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
  if (args.replay) return replayOnly(args, name);
  const env = process.env as Env;
  const rec = recordingFetch(globalThis.fetch.bind(globalThis), { dir: args.out, name, scrub: { env } });
  const { registry, excluded } = await nodeRegistry(args.allowSubprocess);
  if (excluded.length > 0) {
    console.error(
      `record: left out ${excluded.join(', ')}: they spawn processes whose traffic cannot be recorded (pass --allow-subprocess to keep them)`,
    );
  }

  let live: VideoContext;
  try {
    live = await getVideoContext(registry, args.input, args.opts, createContext({ runtime: 'node', env, fetch: rec }));
  } catch (err) {
    console.error(`record: the live run failed: ${(err as Error).message}`);
    if (rec.files.length > 0) console.error(`record: ${rec.files.length} exchange(s) were still written to ${args.out}`);
    return 1;
  }
  return finish(args, name, rec, live, excluded);
}

/** Replay mode (run in a child process, so circuit breakers and caches start fresh): print the replayed transcript as JSON. */
async function replayOnly(args: Args, name: string): Promise<number> {
  const { registry } = await nodeRegistry(args.allowSubprocess, true);
  const replay = replayFetch(fixtureRoutes(args.out, { name }));
  const ctx = createContext({ runtime: 'node', env: process.env as Env, fetch: replay });
  const again = await getVideoContext(registry, args.input, args.opts, ctx);
  process.stdout.write(`${JSON.stringify(transcriptOf(again))}\n`);
  return 0;
}

/** Run this script again with --replay in a fresh process and return the transcript it printed. */
function replayInChild(argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--replay', ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('close', (code) => done({ ok: code === 0, stdout, stderr }));
  });
}

async function finish(
  args: Args,
  name: string,
  rec: ReturnType<typeof recordingFetch>,
  live: VideoContext,
  excluded: string[],
): Promise<number> {
  const out: string[] = [];
  if (excluded.length > 0) out.push(`Left out (they spawn processes): ${excluded.join(', ')}`, '');
  out.push(`Recorded ${rec.files.length} exchange(s) into ${args.out}:`);
  for (const f of rec.files) out.push(`  ${f}`);

  const report = rec.report();
  out.push('', 'Scrubbed:');
  if (report.findings.length === 0) out.push('  nothing (no keys, tokens, cookies or stream IPs were present)');
  for (const f of report.findings) out.push(`  ${f.where}: ${f.what} x${f.count}`);
  for (const w of report.warnings) out.push(`  warning: ${w}`);

  const contextFile = join(args.out, `${name}.context.json`);
  writeFileSync(contextFile, `${JSON.stringify(live, null, 2)}\n`);
  out.push(
    '',
    `Live VideoContext written to ${contextFile} (${live.transcript.segments.length} segments, ${live.transcript.origin}).`,
  );

  if (rec.files.length === 0) {
    out.push(
      'Replay: not verified. Nothing went through fetch, so the transcript came from somewhere a recording cannot capture.',
    );
    process.stdout.write(`${out.join('\n')}\n`);
    return 1;
  }
  if (args.allowSubprocess) {
    out.push('Replay: not verified, because --allow-subprocess lets providers reach the network outside fetch.');
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  }

  // The pipeline part of the command line (input and options after --) goes to the child unchanged.
  const raw = process.argv.slice(2);
  const pipelineArgs = raw.includes('--') ? raw.slice(raw.indexOf('--') + 1) : [];
  const child = await replayInChild(['--out', args.out, '--name', name, '--', ...pipelineArgs]);
  let same = false;
  if (!child.ok) out.push(`Replay: failed in a fresh process:\n${child.stderr.trim().split('\n').slice(-5).join('\n')}`);
  else {
    same = child.stdout.trim() === JSON.stringify(transcriptOf(live));
    out.push(same ? 'Replay: the fixtures reproduce the same transcript.' : 'Replay: MISMATCH, the replayed transcript differs.');
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return same ? 0 : 1;
}

process.exitCode = await main();
