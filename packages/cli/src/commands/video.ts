/** get, list, formats, pack, bundle. */
import {
  buildBundle,
  expandInput,
  formatters,
  render,
  renderMany,
  type Storage,
  type VideoContext,
  Vid2ContextError,
} from '@vid2context/core';
import { bool, positiveInt, str } from '../args.ts';
import { exitCodeFor, UsageError } from '../exit-codes.ts';
import { formatAttempts, formatError, table } from '../output.ts';
import type { CommandContext } from '../runtime.ts';

function one(c: CommandContext, what: string): string {
  if (c.positionals.length !== 1) {
    throw new UsageError(
      c.positionals.length ? `Pass exactly one ${what}, got ${c.positionals.length}.` : `Pass a ${what}.`,
      `Run \`vid2context ${c.args.command.name} --help\`.`,
    );
  }
  return c.positionals[0] as string;
}

/** --json means the json format; --format with another id beside --json is a contradiction. */
function formatOf(c: CommandContext, fallback = 'text'): string {
  const format = str(c.values, 'format');
  if (c.json && format && format !== 'json') throw new UsageError(`--json and --format ${format} contradict each other.`, 'Pass one.');
  const id = c.json ? 'json' : (format ?? fallback);
  if (!formatters[id]) {
    throw new UsageError(`Unknown format "${id}".`, `Available: ${Object.keys(formatters).join(', ')}. See \`vid2context formats\`.`);
  }
  return id;
}

export async function getCommand(c: CommandContext): Promise<number> {
  const input = one(c, 'video URL or file path');
  const format = formatOf(c);
  c.progress.start(`Fetching ${input}`);
  let context: VideoContext;
  try {
    context = await c.fetchContext(input, await c.persistentStorage());
  } finally {
    c.progress.stop();
  }
  c.out.text(
    render(context, format, {
      timestamps: bool(c.values, 'timestamps'),
      includeComments: c.values.comments !== undefined ? true : undefined,
    }),
  );
  if (c.verbose) c.deps.io.stderr(formatAttempts(context.attempts));
  return 0;
}

export async function listCommand(c: CommandContext): Promise<number> {
  const input = one(c, 'playlist, channel, feed or page URL');
  c.progress.start(`Listing ${input}`);
  let refs: Awaited<ReturnType<typeof expandInput>>;
  try {
    refs = await expandInput(c.deps.registry, input, c.deps.ctx, { limit: positiveInt(c.values, 'limit') });
  } finally {
    c.progress.stop();
  }
  if (c.json) c.out.text(`${JSON.stringify(refs, null, 2)}\n`);
  else c.out.text(refs.map((r) => `${r.url ?? r.id}\n`).join(''));
  c.note(`${refs.length} item${refs.length === 1 ? '' : 's'}`);
  return 0;
}

export async function formatsCommand(c: CommandContext): Promise<number> {
  const all = Object.values(formatters);
  if (c.json) {
    const rows = all.map((f) => ({
      id: f.id,
      description: f.description,
      mimeType: f.mimeType,
      extension: f.extension,
      multiVideo: typeof f.renderMany === 'function',
    }));
    c.out.text(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    const rows = [['ID', 'EXT', 'VIDEOS', 'DESCRIPTION'], ...all.map((f) => [f.id, f.extension, f.renderMany ? 'many' : 'one', f.description])];
    c.out.text(`${table(rows)}\n`);
  }
  return 0;
}

/**
 * Fetch every input (lists expanded), saving to the library. Failures are
 * reported on stderr and the rest continue; the first failure decides the exit
 * code. Throws when nothing succeeded.
 */
async function gather(c: CommandContext, storage: Storage | null): Promise<{ contexts: VideoContext[]; firstError?: unknown }> {
  if (c.positionals.length === 0) throw new UsageError('Pass one or more inputs.', `Run \`vid2context ${c.args.command.name} --help\`.`);
  const inputs: string[] = [];
  for (const input of c.positionals) {
    c.progress.start(`Resolving ${input}`);
    try {
      const refs = await expandInput(c.deps.registry, input, c.deps.ctx);
      inputs.push(...refs.map((r) => r.url ?? r.input));
    } finally {
      c.progress.stop();
    }
  }
  const contexts: VideoContext[] = [];
  let firstError: unknown;
  for (const [i, input] of inputs.entries()) {
    c.progress.start(`[${i + 1}/${inputs.length}] ${input}`);
    try {
      contexts.push(await c.fetchContext(input, storage));
    } catch (err) {
      firstError ??= err;
      c.progress.stop();
      c.deps.io.stderr(`skipped ${input}\n${formatError(err, c.verbose)}`);
    } finally {
      c.progress.stop();
    }
  }
  if (contexts.length === 0) {
    throw firstError ?? new Vid2ContextError('bad-request', 'No videos to process.', { hint: 'The inputs expanded to nothing.' });
  }
  return { contexts, firstError };
}

export async function packCommand(c: CommandContext): Promise<number> {
  const format = str(c.values, 'format');
  if (format && format !== 'pack') throw new UsageError('`pack` always writes the pack format.', 'Use `get --format` for other formats.');
  const maxTokens = positiveInt(c.values, 'max-tokens');
  const { contexts, firstError } = await gather(c, await c.persistentStorage());
  c.out.text(
    renderMany(contexts, 'pack', {
      maxTokens,
      timestamps: bool(c.values, 'timestamps'),
      includeComments: c.values.comments !== undefined ? true : undefined,
    }),
  );
  return firstError ? exitCodeFor(firstError) : 0;
}

export async function bundleCommand(c: CommandContext): Promise<number> {
  if (!c.out.toFile) throw new UsageError('`bundle` writes a .zip and needs --out.', 'Example: vid2context bundle jNQXAC9IVRw -o zoo.zip');
  const { contexts, firstError } = await gather(c, await c.persistentStorage());
  const bundle = await buildBundle(contexts, {
    maxTokens: positiveInt(c.values, 'max-tokens'),
    comments: c.values.comments !== undefined ? true : undefined,
    name: str(c.values, 'name'),
  });
  c.out.bytes(new Uint8Array(await new Response(bundle.zip()).arrayBuffer()));
  // The zip goes to the --out file, so stdout is free for the manifest.
  if (c.json) c.deps.io.stdout(`${JSON.stringify(bundle.manifest, null, 2)}\n`);
  else c.note(`${bundle.files.length} files for ${contexts.length} video${contexts.length === 1 ? '' : 's'} in ${bundle.root}/`);
  return firstError ? exitCodeFor(firstError) : 0;
}
