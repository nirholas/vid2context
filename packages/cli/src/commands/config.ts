/**
 * `config`: the resolved settings and where each came from, secrets masked.
 * The trace comes from @vid2context/config (`trace` and `explain`), which
 * covers the environment alone when there is no config file.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Config, explain, parseConfig, type TraceEntry, trace } from '@vid2context/config';
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

/**
 * Where the config file is, in the order `findConfigFile` in @vid2context/config/node
 * documents: VID2CONTEXT_CONFIG, ./vid2context.config.json, ./vid2context.config.jsonc,
 * $XDG_CONFIG_HOME/vid2context/config.json (default ~/.config). Done here rather
 * than imported because config/node loads the whole provider registry, and
 * `config` must still work when one provider is broken.
 */
export function findConfigFile(env: Env, cwd: string): { path?: string; searched: string[] } {
  const explicit = env.VID2CONTEXT_CONFIG;
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) {
      throw new Vid2ContextError('bad-request', `VID2CONTEXT_CONFIG points to ${path}, which does not exist.`, {
        hint: 'Fix the path, or unset VID2CONTEXT_CONFIG to use ./vid2context.config.json or ~/.config/vid2context/config.json.',
      });
    }
    return { path, searched: [path] };
  }
  const xdg = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  const searched = [
    resolve(cwd, 'vid2context.config.json'),
    resolve(cwd, 'vid2context.config.jsonc'),
    join(xdg, 'vid2context', 'config.json'),
  ];
  return { path: searched.find((p) => existsSync(p)), searched };
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
  const where = findConfigFile(env, cwd);
  const config: Config | undefined = where.path
    ? parseConfig(await readFile(where.path, 'utf8'), { source: where.path })
    : undefined;
  if (profile && !config) {
    throw new Vid2ContextError('bad-request', `Profile "${profile}" was asked for, but no config file was found.`, {
      hint: `Create one of: ${where.searched.join(', ')}.`,
    });
  }
  const name = config ? profile || env.VID2CONTEXT_PROFILE || config.defaultProfile || 'default' : undefined;
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
