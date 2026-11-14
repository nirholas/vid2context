import { type Policy, Vid2ContextError } from '@vid2context/core';
import type { Config, PerStage, Profile, ProfileDefaults, ProfileLimits, Stage } from './definition.ts';
import { DOCS_HINT } from './validate.ts';

export type StageKey = 'default' | Stage;
export type StageMap<T> = Partial<Record<StageKey, T>>;

/** A profile with `extends` applied: every setting flat, plus which profile set it. */
export interface ResolvedProfile {
  name: string;
  /** The profile followed by its ancestors, nearest first. */
  lineage: string[];
  description?: string;
  policy: StageMap<Policy>;
  allowPaid?: boolean;
  keyless?: boolean;
  prefer: StageMap<string[]>;
  skip: StageMap<string[]>;
  only: StageMap<string[]>;
  models: Record<string, string | string[]>;
  storage?: string;
  defaults: ProfileDefaults;
  limits: ProfileLimits;
  env: Record<string, string>;
  /** Profile that set each setting, keyed by path: "policy.stt", "models.groq:stt", "env.FOO", "allowPaid". */
  sources: Record<string, string>;
}

function perStage<T>(v: PerStage<T> | undefined, isValue: (x: unknown) => boolean): StageMap<T> {
  if (v === undefined) return {};
  if (isValue(v)) return { default: v as T };
  return { ...(v as StageMap<T>) };
}

/** Flatten one profile to leaf settings keyed by path. Per-stage fields always use the object form. */
function leaves(p: Profile): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const put = (path: string, v: unknown) => {
    if (v !== undefined) out.set(path, v);
  };
  put('description', p.description);
  for (const [k, v] of Object.entries(perStage(p.policy, (x) => typeof x === 'string'))) put(`policy.${k}`, v);
  put('allowPaid', p.allowPaid);
  put('keyless', p.keyless);
  for (const field of ['prefer', 'skip', 'only'] as const) {
    for (const [k, v] of Object.entries(perStage(p[field], Array.isArray))) put(`${field}.${k}`, v);
  }
  for (const [k, v] of Object.entries(p.models ?? {})) put(`models.${k}`, v);
  put('storage', p.storage);
  for (const [k, v] of Object.entries(p.defaults ?? {})) put(`defaults.${k}`, v);
  for (const [k, v] of Object.entries(p.limits ?? {})) put(`limits.${k}`, v);
  for (const [k, v] of Object.entries(p.env ?? {})) put(`env.${k}`, v);
  return out;
}

/**
 * Apply `extends` and merge into one flat profile. A child overrides its
 * parent setting by setting: objects merge key by key, per-stage values merge
 * stage by stage, and lists replace (they never concatenate).
 */
export function resolveProfile(config: Config, name: string): ResolvedProfile {
  if (!config.profiles[name]) {
    throw new Vid2ContextError('bad-request', `No profile named "${name}" in the config.`, {
      hint: `Profiles in this config: ${Object.keys(config.profiles).join(', ') || '(none)'}. ${DOCS_HINT}`,
    });
  }
  const lineage: string[] = [];
  for (let cur: string | undefined = name; cur !== undefined; cur = config.profiles[cur]?.extends) {
    if (lineage.includes(cur)) {
      throw new Vid2ContextError('bad-request', `Profile extends cycle: ${[...lineage, cur].join(' -> ')}.`, {
        hint: `Remove one of the extends links. ${DOCS_HINT}`,
      });
    }
    if (!config.profiles[cur]) {
      throw new Vid2ContextError('bad-request', `Profile "${lineage.at(-1)}" extends "${cur}", which does not exist.`, {
        hint: DOCS_HINT,
      });
    }
    lineage.push(cur);
  }
  const merged = new Map<string, { value: unknown; from: string }>();
  for (const profileName of [...lineage].reverse()) {
    const profile = config.profiles[profileName] as Profile;
    for (const [path, value] of leaves(profile)) merged.set(path, { value, from: profileName });
  }
  const r: ResolvedProfile = {
    name,
    lineage,
    policy: {},
    prefer: {},
    skip: {},
    only: {},
    models: {},
    defaults: {},
    limits: {},
    env: {},
    sources: {},
  };
  for (const [path, { value, from }] of merged) {
    r.sources[path] = from;
    const dot = path.indexOf('.');
    const head = dot === -1 ? path : path.slice(0, dot);
    const tail = path.slice(dot + 1);
    const bag = r as unknown as Record<string, unknown>;
    if (dot === -1) bag[head] = value;
    else (bag[head] as Record<string, unknown>)[tail] = value;
  }
  return r;
}
