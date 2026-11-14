/**
 * `config`: the resolved settings and where each came from, secrets masked.
 * The trace comes from @vid2context/config (`trace` and `explain`), which
 * covers the environment alone when there is no config file.
 */
import { explain, type TraceEntry, trace } from '@vid2context/config';
import { type Env, type Registry, Vid2ContextError } from '@vid2context/core';
import { str } from '../args.ts';
import type { CommandContext } from '../runtime.ts';

export interface StorageInfo {
  /** Provider id of the backend in use, or "memory". */
  backend: string;
  persistent: boolean;
  /** Installed storage providers and whether each is enabled by env. */
  available: { id: string; enabled: boolean }[];
}

export function storageInfo(registry: Registry, env: Env): StorageInfo {
  const all = registry.storages().sort((a, b) => a.priority - b.priority);
  const available = all.map((s) => ({ id: s.id, enabled: s.isEnabled(env) }));
  const first = all.find((s) => s.isEnabled(env));
  return { backend: first?.id ?? 'memory', persistent: Boolean(first), available };
}

export interface ConfigReport {
  configPath?: string;
  searched: string[];
  profile?: string;
  settings: TraceEntry[];
  storage: StorageInfo;
}

export async function configReport(
  registry: Registry,
  env: Env,
  cwd: string,
  profile?: string,
): Promise<{ report: ConfigReport; text: string }> {
  // Loaded lazily: @vid2context/config/node pulls in the full provider registry.
  const { findConfigFile, loadConfigFile, selectProfile } = await import('@vid2context/config/node');
  const where = findConfigFile(env, cwd);
  const config = where.path ? await loadConfigFile(where.path) : undefined;
  if (profile && !config) {
    throw new Vid2ContextError('bad-request', `Profile "${profile}" was asked for, but no config file was found.`, {
      hint: `Create one of: ${where.searched.join(', ')}.`,
    });
  }
  const name = config ? selectProfile(config, env, profile) : undefined;
  const storage = storageInfo(registry, env);
  const report: ConfigReport = {
    configPath: where.path,
    searched: where.searched,
    profile: name,
    settings: trace(config, name, env),
    storage,
  };
  const storageLine = storage.persistent
    ? `Storage backend: ${storage.backend}`
    : `Storage backend: memory (no persistent backend enabled; the library lives only for one process)${
        storage.available.length ? `. Installed: ${storage.available.map((s) => s.id).join(', ')}` : ''
      }`;
  const text = `${explain(config, name, env, { configPath: where.path })}\n\n${storageLine}\n`;
  return { report, text };
}

export async function configCommand(c: CommandContext): Promise<number> {
  const { report, text } = await configReport(c.deps.registry, c.deps.ctx.env, c.cwd, str(c.values, 'profile'));
  c.out.text(c.json ? `${JSON.stringify(report, null, 2)}\n` : text);
  return 0;
}
