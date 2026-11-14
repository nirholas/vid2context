/** search, library, collection: all over the Storage contract. */
import {
  type Collection,
  expandInput,
  formatTimestamp,
  formatters,
  render,
  type Storage,
  timestampUrl,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { bool, list, positiveInt, str } from '../args.ts';
import { UsageError } from '../exit-codes.ts';
import { table } from '../output.ts';
import type { CommandContext } from '../runtime.ts';

function backendNote(c: CommandContext, storage: Storage): void {
  if (storage.backend === 'memory') {
    c.note(
      'note: no persistent storage backend is enabled, so this library lives only for this process (see `vid2context config`).',
    );
  }
}

function sub(c: CommandContext, allowed: string[]): string {
  const name = c.positionals[0];
  if (!name || !allowed.includes(name)) {
    throw new UsageError(
      name ? `Unknown ${c.args.command.name} subcommand "${name}".` : `Pass a ${c.args.command.name} subcommand.`,
      `One of: ${allowed.join(', ')}. Run \`vid2context ${c.args.command.name} --help\`.`,
    );
  }
  return name;
}

function arg(c: CommandContext, index: number, what: string): string {
  const v = c.positionals[index];
  if (!v) throw new UsageError(`Pass ${what}.`, `Run \`vid2context ${c.args.command.name} --help\`.`);
  return v;
}

function notFound(kind: string, id: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('not-found', `${kind} not found: ${id}`, { hint });
}

function duration(sec: number | undefined): string {
  return sec === undefined ? '' : formatTimestamp(sec);
}

function emit(c: CommandContext, value: unknown, text: string): void {
  c.out.text(c.json ? `${JSON.stringify(value, null, 2)}\n` : text);
}

// ---------------------------------------------------------------- search

export async function searchCommand(c: CommandContext): Promise<number> {
  if (c.positionals.length === 0) throw new UsageError('Pass a search query.', 'Example: vid2context search "elephants"');
  const storage = await c.storage();
  backendNote(c, storage);
  const hits = await storage.search({
    text: c.positionals.join(' '),
    collectionId: str(c.values, 'collection'),
    limit: positiveInt(c.values, 'limit'),
  });
  const contexts = new Map<string, VideoContext | null>();
  const rows = [];
  for (const h of hits) {
    if (!contexts.has(h.videoId)) contexts.set(h.videoId, await storage.getContext(h.videoId));
    const ref = contexts.get(h.videoId)?.metadata.ref;
    rows.push({ ...h, url: ref ? timestampUrl(ref, h.startSec) : undefined });
  }
  emit(
    c,
    rows,
    rows.map((r) => `${r.title} [${formatTimestamp(r.startSec)}] ${r.text.trim()}\n${r.url ? `  ${r.url}\n` : ''}`).join(''),
  );
  c.note(`${rows.length} hit${rows.length === 1 ? '' : 's'}`);
  return 0;
}

// ---------------------------------------------------------------- library

export async function libraryCommand(c: CommandContext): Promise<number> {
  const action = sub(c, ['ls', 'show', 'rm']);
  const storage = await c.storage();
  backendNote(c, storage);
  if (action === 'ls') {
    const page = await storage.listContexts({ limit: positiveInt(c.values, 'limit') });
    emit(
      c,
      page,
      page.items.length
        ? `${table([
            ['ID', 'ORIGIN', 'LANG', 'LENGTH', 'TITLE'],
            ...page.items.map((s) => [s.id, s.origin, s.language, duration(s.durationSec), s.title]),
          ])}\n`
        : '',
    );
    if (!page.items.length)
      c.note('The library is empty. `vid2context get <url>` saves videos when a storage backend is enabled.');
    return 0;
  }
  const id = arg(c, 1, 'a library id, e.g. youtube:jNQXAC9IVRw');
  const context = await storage.getContext(id);
  if (!context) throw notFound('Library item', id, 'Run `vid2context library ls` to see saved ids.');
  if (action === 'show') {
    const format = c.json ? 'json' : (str(c.values, 'format') ?? 'text');
    if (!formatters[format])
      throw new UsageError(`Unknown format "${format}".`, `Available: ${Object.keys(formatters).join(', ')}.`);
    c.out.text(render(context, format, { timestamps: bool(c.values, 'timestamps') }));
    return 0;
  }
  await storage.deleteContext(id);
  emit(c, { deleted: id }, `deleted ${id}\n`);
  return 0;
}

// ---------------------------------------------------------------- collection

async function mustCollection(storage: Storage, id: string): Promise<Collection> {
  const col = await storage.getCollection(id);
  if (!col) throw notFound('Collection', id, 'Run `vid2context collection ls` to see collection ids.');
  return col;
}

function collectionText(col: Collection, titles: Map<string, string>): string {
  const lines = [`${col.name} (${col.id})`];
  if (col.description) lines.push(col.description);
  if (col.sources.length) lines.push(`sources: ${col.sources.join(', ')}`);
  lines.push(`${col.videoIds.length} video${col.videoIds.length === 1 ? '' : 's'}`);
  for (const v of col.videoIds) lines.push(`  ${v}${titles.get(v) ? `  ${titles.get(v)}` : ''}`);
  return `${lines.join('\n')}\n`;
}

async function titlesOf(storage: Storage, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of ids) {
    const ctx = await storage.getContext(id);
    if (ctx) out.set(id, ctx.metadata.title);
  }
  return out;
}

export async function collectionCommand(c: CommandContext): Promise<number> {
  const action = sub(c, ['create', 'add', 'ls', 'show', 'rm']);
  const storage = await c.storage();
  backendNote(c, storage);

  if (action === 'create') {
    const name = c.positionals.slice(1).join(' ');
    if (!name) throw new UsageError('Pass a collection name.', 'Example: vid2context collection create "Talks"');
    const col = await storage.createCollection({
      name,
      description: str(c.values, 'description'),
      sources: list(c.values, 'source'),
    });
    emit(c, col, `${col.id}\n`);
    return 0;
  }

  if (action === 'ls') {
    const cols = await storage.listCollections();
    emit(
      c,
      cols,
      cols.length ? `${table([['ID', 'VIDEOS', 'NAME'], ...cols.map((x) => [x.id, String(x.videoIds.length), x.name])])}\n` : '',
    );
    if (!cols.length) c.note('No collections yet. Create one with `vid2context collection create <name>`.');
    return 0;
  }

  const id = arg(c, 1, 'a collection id');
  const col = await mustCollection(storage, id);

  if (action === 'show') {
    emit(c, col, collectionText(col, await titlesOf(storage, col.videoIds)));
    return 0;
  }

  if (action === 'add') {
    const inputs = c.positionals.slice(2);
    if (!inputs.length)
      throw new UsageError('Pass one or more videos to add.', 'Example: vid2context collection add <id> jNQXAC9IVRw');
    const ids: string[] = [];
    for (const input of inputs) {
      // A library id that is already saved needs no network.
      if (await storage.getContext(input)) {
        ids.push(input);
        continue;
      }
      const refs = await expandInput(c.deps.registry, input, c.deps.ctx);
      for (const [i, ref] of refs.entries()) {
        c.progress.start(`[${i + 1}/${refs.length}] ${ref.url ?? ref.input}`);
        try {
          const ctx = await c.fetchContext(ref.url ?? ref.input, storage);
          ids.push(ctx.metadata.ref.id);
        } finally {
          c.progress.stop();
        }
      }
    }
    const updated = await storage.addToCollection(id, ids);
    emit(c, updated, collectionText(updated, await titlesOf(storage, updated.videoIds)));
    return 0;
  }

  // rm: with video ids, remove them from the collection; without, delete the collection.
  const videos = c.positionals.slice(2);
  if (videos.length) {
    const updated = await storage.removeFromCollection(col.id, videos);
    emit(c, updated, collectionText(updated, await titlesOf(storage, updated.videoIds)));
  } else {
    await storage.deleteCollection(col.id);
    emit(c, { deleted: col.id }, `deleted ${col.id}\n`);
  }
  return 0;
}
