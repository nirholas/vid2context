/** What every command receives: parsed flags, the registry and context, output, progress and storage. */
import {
  type ChainOptions,
  type Ctx,
  type GetContextOptions,
  getVideoContext,
  MemoryStorage,
  type Registry,
  type Storage,
  type VideoContext,
} from '@vid2context/core';
import { bool, choice, type FlagValue, list, type ParsedArgs, str } from './args.ts';
import type { Exec } from './exec.ts';
import { UsageError } from './exit-codes.ts';
import { type Io, Output, Progress } from './output.ts';
import { MODES, POLICIES } from './spec.ts';

export interface RunDeps {
  registry: Registry;
  ctx: Ctx;
  io: Io;
  /** Library backend. Default: the registry's enabled storage provider, else an in-process MemoryStorage. */
  storage?: Storage;
  /** Runs external programs for `doctor`. Default: node:child_process. */
  exec?: Exec;
  /** Working directory for --out and the data directory. Default: process.cwd(). */
  cwd?: string;
}

export interface CommandContext {
  deps: RunDeps;
  args: ParsedArgs;
  values: Record<string, FlagValue>;
  positionals: string[];
  version: string;
  out: Output;
  progress: Progress;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  cwd: string;
  /** A line on stderr, unless --quiet. */
  note(msg: string): void;
  /** The library: persistent backend when one is enabled, else MemoryStorage for this process. */
  storage(): Promise<Storage>;
  /** The persistent backend, or null when none is enabled. `get` caches only there. */
  persistentStorage(): Promise<Storage | null>;
  chain: ChainOptions;
  getOptions(): GetContextOptions;
  /** Fetch one video's context with the global flags applied, saving it to the library. */
  fetchContext(input: string, storage?: Storage | null): Promise<VideoContext>;
}

export function makeContext(deps: RunDeps, args: ParsedArgs, version: string): CommandContext {
  const { values } = args;
  const cwd = deps.cwd ?? process.cwd();
  const json = bool(values, 'json');
  const quiet = bool(values, 'quiet');
  const verbose = bool(values, 'verbose');
  const io = deps.io;
  const policy = choice(values, 'policy', POLICIES);
  const chain: ChainOptions = {
    policy,
    allowPaid: bool(values, 'allow-paid') ? true : undefined,
    only: list(values, 'only'),
    skip: list(values, 'skip'),
  };
  const mode = choice(values, 'mode', MODES);

  let persistent: Promise<Storage | null> | undefined;
  let storage: Promise<Storage> | undefined;
  const persistentStorage = () => {
    persistent ??= deps.storage ? Promise.resolve(deps.storage) : deps.registry.openStorage(deps.ctx);
    return persistent;
  };

  const commentsRaw = str(values, 'comments');
  const comments = commentsRaw === undefined ? undefined : commentsRaw === 'all' ? true : Number(commentsRaw);
  if (comments === 0) throw new UsageError('--comments must be 1 or more.');

  const ctx: CommandContext = {
    deps,
    args,
    values,
    positionals: args.positionals,
    version,
    out: new Output(io, str(values, 'out'), bool(values, 'force'), cwd),
    progress: new Progress(io, Boolean(io.stderrIsTTY) && !quiet),
    json,
    quiet,
    verbose,
    cwd,
    note: (msg) => {
      if (!quiet) io.stderr(`${msg}\n`);
    },
    persistentStorage,
    storage: () => {
      storage ??= persistentStorage().then((s) => s ?? new MemoryStorage());
      return storage;
    },
    chain,
    getOptions: () => ({
      mode,
      language: str(values, 'lang'),
      chain,
      comments,
      refresh: bool(values, 'refresh'),
    }),
    async fetchContext(input, store) {
      return getVideoContext(deps.registry, input, { ...ctx.getOptions(), storage: store ?? null }, deps.ctx);
    },
  };
  return ctx;
}
