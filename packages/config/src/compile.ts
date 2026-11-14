import type { ChainOptions, Env, Rung } from '@vid2context/core';
import type { Config, Stage } from './definition.ts';
import { MODEL_KEYS } from './models.ts';
import { type ResolvedProfile, resolveProfile } from './resolve.ts';

/** One env var a profile emits, and where it came from. */
export interface EnvEntry {
  name: string;
  value: string;
  /** Profile setting path that produced it: "policy.default", "models.groq", "env.FOO". */
  path: string;
  /** Profile that set it. */
  from: string;
  /** For "env:NAME" references: the variable the value was read from. */
  ref?: string;
}

/** A setting whose "env:NAME" reference pointed at an unset variable, so nothing was emitted. */
export interface MissingRef {
  path: string;
  from: string;
  ref: string;
}

const bool = (v: boolean) => (v ? '1' : '0');

function isSet(v: string | undefined): v is string {
  return v !== undefined && v !== '';
}

/** Compile a resolved profile to env entries, resolving "env:NAME" references against `env`. */
export function compileProfile(r: ResolvedProfile, env: Env = {}): { entries: EnvEntry[]; missing: MissingRef[] } {
  const entries: EnvEntry[] = [];
  const missing: MissingRef[] = [];
  const add = (name: string, value: string, path: string) => {
    entries.push({ name, value, path, from: r.sources[path] ?? r.name });
  };
  const addRef = (name: string, raw: string, path: string) => {
    if (!raw.startsWith('env:')) return add(name, raw, path);
    const ref = raw.slice(4);
    const from = r.sources[path] ?? r.name;
    const v = env[ref];
    if (isSet(v)) entries.push({ name, value: v, path, from, ref });
    else missing.push({ path, from, ref });
  };

  if (r.policy.default) add('VID2CONTEXT_POLICY', r.policy.default, 'policy.default');
  if (r.allowPaid !== undefined) add('VID2CONTEXT_ALLOW_PAID', bool(r.allowPaid), 'allowPaid');
  if (r.keyless !== undefined) add('VID2CONTEXT_KEYLESS', bool(r.keyless), 'keyless');
  if (r.skip.default) add('VID2CONTEXT_SKIP', r.skip.default.join(','), 'skip.default');
  for (const [key, value] of Object.entries(r.models)) {
    const name = MODEL_KEYS[key];
    if (!name) continue;
    if (Array.isArray(value)) add(name, value.join(','), `models.${key}`);
    else addRef(name, value, `models.${key}`);
  }
  if (r.storage) add('VID2CONTEXT_STORAGE', r.storage, 'storage');
  const d = r.defaults;
  if (d.format !== undefined) add('VID2CONTEXT_FORMAT', d.format, 'defaults.format');
  if (d.timestamps !== undefined) add('VID2CONTEXT_TIMESTAMPS', bool(d.timestamps), 'defaults.timestamps');
  if (d.mode !== undefined) add('VID2CONTEXT_MODE', d.mode, 'defaults.mode');
  if (d.language !== undefined) add('VID2CONTEXT_LANG', d.language, 'defaults.language');
  if (d.comments !== undefined) {
    add('VID2CONTEXT_COMMENTS', typeof d.comments === 'number' ? String(d.comments) : bool(d.comments), 'defaults.comments');
  }
  const l = r.limits;
  if (l.maxPlaylistItems !== undefined)
    add('VID2CONTEXT_MAX_PLAYLIST_ITEMS', String(l.maxPlaylistItems), 'limits.maxPlaylistItems');
  if (l.maxUploadMb !== undefined) add('VID2CONTEXT_MAX_UPLOAD_MB', String(l.maxUploadMb), 'limits.maxUploadMb');
  if (l.maxAudioMb !== undefined) add('VID2CONTEXT_MAX_AUDIO_MB', String(l.maxAudioMb), 'limits.maxAudioMb');
  for (const [name, value] of Object.entries(r.env)) addRef(name, value, `env.${name}`);
  return { entries, missing };
}

/**
 * The env overlay for a profile. Pass the real environment as `env` so
 * "env:NAME" references resolve; a reference to an unset variable emits
 * nothing. Merge the result with `mergeEnv`, never by spreading it over the
 * real environment.
 */
export function toEnv(config: Config, profileName: string, env: Env = {}): Record<string, string> {
  const { entries } = compileProfile(resolveProfile(config, profileName), env);
  return Object.fromEntries(entries.map((e) => [e.name, e.value]));
}

/**
 * Merge a config overlay into the real environment. The real environment wins:
 * a variable already set in `base` (not undefined and not empty) is kept, so a
 * shell or .env value always beats the config file, and the config beats the
 * built-in defaults.
 */
export function mergeEnv(base: Env, overlay: Env): Env {
  const out: Env = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v !== undefined && !isSet(base[k])) out[k] = v;
  }
  return out;
}

/** Chain options for one stage, plus the profile's reordering hint. */
export interface StageChainOptions extends ChainOptions {
  /** Rung ids, services or providers to move to the front. Apply with `applyPrefer` after `rankRungs`. */
  prefer: string[];
}

/**
 * Chain options for one rung stage. A stage value beats the profile default.
 * `only` and `prefer` replace per stage; `skip` adds the stage list to the
 * default list.
 *
 * Pass the real environment (before merging) as `realEnv` so it keeps winning:
 * when it sets VID2CONTEXT_POLICY, VID2CONTEXT_ALLOW_PAID or VID2CONTEXT_SKIP,
 * the profile default for that control is left out (the chain reads the env
 * value). A stage-specific profile value is more specific than a global env
 * control and is always applied.
 */
export function chainOptionsFor(stage: Stage, r: ResolvedProfile, realEnv: Env = {}): StageChainOptions {
  const out: StageChainOptions = { prefer: r.prefer[stage] ?? r.prefer.default ?? [] };
  const policy = r.policy[stage] ?? (isSet(realEnv.VID2CONTEXT_POLICY) ? undefined : r.policy.default);
  if (policy) out.policy = policy;
  if (r.allowPaid !== undefined && !isSet(realEnv.VID2CONTEXT_ALLOW_PAID)) out.allowPaid = r.allowPaid;
  const only = r.only[stage] ?? r.only.default;
  if (only) out.only = [...only];
  const skip = [...(isSet(realEnv.VID2CONTEXT_SKIP) ? [] : (r.skip.default ?? [])), ...(r.skip[stage] ?? [])];
  if (skip.length > 0) out.skip = [...new Set(skip)];
  return out;
}

function preferIndex(rung: Rung, prefer: string[]): number {
  const i = prefer.findIndex((k) => k === rung.id || k === rung.service || k === rung.provider);
  return i === -1 ? prefer.length : i;
}

/**
 * Move preferred rungs to the front of an already ranked list, in the order
 * the `prefer` list names them. Everything else keeps its ranked order behind
 * them. Nothing is added or removed: prefer never overrides policy, only or skip.
 */
export function applyPrefer<R extends Rung>(ranked: R[], prefer: string[]): R[] {
  if (prefer.length === 0) return [...ranked];
  return ranked
    .map((rung, i) => ({ rung, i, p: preferIndex(rung, prefer) }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.rung);
}
