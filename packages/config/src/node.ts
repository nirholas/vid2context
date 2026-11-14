/**
 * @vid2context/config/node: find and load the config file, load .env files,
 * and return the merged env for a surface:
 *
 *   const { env } = await loadConfiguredEnv();
 *   const ctx = createNodeContext({ env });
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Env, Vid2ContextError } from '@vid2context/core';
import { loadEnvFiles } from '@vid2context/registry/node';
import { chainOptionsFor, mergeEnv, type StageChainOptions, toEnv } from './compile.ts';
import type { Config, Stage } from './definition.ts';
import { explain } from './explain.ts';
import { type ResolvedProfile, resolveProfile } from './resolve.ts';
import { DOCS_HINT, parseConfig } from './validate.ts';

export interface LoadOptions {
  /** Directory to search for ./vid2context.config.json(c) and ./.env. Default: process.cwd(). */
  cwd?: string;
  /** Profile to use; beats VID2CONTEXT_PROFILE and defaultProfile. */
  profile?: string;
  /**
   * The real environment. Default: process.env after loading .env files.
   * When given, .env files are not loaded (the caller owns the environment).
   */
  env?: Env;
}

export interface ConfigLocation {
  /** The file that will be used, or undefined when none exists. */
  path?: string;
  /** Every path checked, in order. */
  searched: string[];
}

/**
 * Where the config file is: VID2CONTEXT_CONFIG, then ./vid2context.config.json,
 * then ./vid2context.config.jsonc, then $XDG_CONFIG_HOME/vid2context/config.json
 * (default ~/.config/vid2context/config.json). The first that exists wins.
 * VID2CONTEXT_CONFIG naming a missing file is an error, not a silent fallback.
 */
export function findConfigFile(env: Env, cwd: string = process.cwd()): ConfigLocation {
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

/** Read, parse and validate one config file. */
export async function loadConfigFile(path: string): Promise<Config> {
  return parseConfig(await readFile(path, 'utf8'), { source: path });
}

/** Explicit argument, then VID2CONTEXT_PROFILE, then the file's defaultProfile, then "default". */
export function selectProfile(config: Config, env: Env, explicit?: string): string {
  return explicit || env.VID2CONTEXT_PROFILE || config.defaultProfile || 'default';
}

export interface ConfiguredEnv {
  /** The environment to run with: real env merged over the profile's overlay (real env wins). */
  env: Env;
  /** The profile used, or undefined without a config file. */
  profile?: string;
  /** The config file used, or undefined when none was found. */
  configPath?: string;
  /** Every config path checked, in order. */
  searched: string[];
  /** .env files loaded (paths only). */
  envFiles: string[];
  /** The resolved profile, for surfaces that need per-stage settings. */
  resolved?: ResolvedProfile;
  /** Per-stage chain options (stage policy, only, skip, prefer); real env controls still win. */
  chainOptionsFor(stage: Stage): StageChainOptions;
  /** Readable trace of every effective setting, secrets masked. */
  explain: string;
}

/**
 * Load .env files, find the config file, compile the selected profile and
 * merge it under the real environment. No config file is not an error: the
 * environment is returned unchanged.
 */
export async function loadConfiguredEnv(opts: LoadOptions = {}): Promise<ConfiguredEnv> {
  const cwd = opts.cwd ?? process.cwd();
  const envFiles = opts.env ? [] : loadEnvFiles(cwd);
  const base: Env = opts.env ?? { ...(process.env as Env) };
  const where = findConfigFile(base, cwd);
  if (!where.path) {
    if (opts.profile) {
      throw new Vid2ContextError('bad-request', `Profile "${opts.profile}" was asked for, but no config file was found.`, {
        hint: `Create one of: ${where.searched.join(', ')}. ${DOCS_HINT}`,
      });
    }
    return {
      env: base,
      searched: where.searched,
      envFiles,
      chainOptionsFor: () => ({ prefer: [] }),
      explain: explain(undefined, undefined, base),
    };
  }
  const config = await loadConfigFile(where.path);
  const profile = selectProfile(config, base, opts.profile);
  const resolved = resolveProfile(config, profile);
  const env = mergeEnv(base, toEnv(config, profile, base));
  return {
    env,
    profile,
    configPath: where.path,
    searched: where.searched,
    envFiles,
    resolved,
    chainOptionsFor: (stage) => chainOptionsFor(stage, resolved, base),
    explain: explain(config, profile, base, { configPath: where.path }),
  };
}
