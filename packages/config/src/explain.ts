import type { Env } from '@vid2context/core';
import { compileProfile, type EnvEntry, type MissingRef } from './compile.ts';
import { type Config, STAGES } from './definition.ts';
import { MODEL_ENV_VARS } from './models.ts';
import { type ResolvedProfile, resolveProfile, type StageKey } from './resolve.ts';
import { CONTROLLED_ENV, isSecretName, looksLikeKey } from './validate.ts';

/** One line of the trace. */
export interface TraceEntry {
  setting: string;
  /** Effective value, masked when it is a secret. */
  value: string;
  /** Where the value came from: "profile work", "extends base", "env GROQ_MODEL", "default". */
  source: string;
}

/** What each controlled variable does when nobody sets it. */
const DEFAULTS: Record<string, string> = {
  VID2CONTEXT_POLICY: 'free',
  VID2CONTEXT_ALLOW_PAID: '1',
  VID2CONTEXT_KEYLESS: '1',
  VID2CONTEXT_SKIP: '(none)',
  VID2CONTEXT_STORAGE: '(first enabled backend)',
  VID2CONTEXT_FORMAT: '(surface default)',
  VID2CONTEXT_TIMESTAMPS: '(surface default)',
  VID2CONTEXT_MODE: '(surface default)',
  VID2CONTEXT_LANG: '(spoken language)',
  VID2CONTEXT_COMMENTS: '(surface default)',
  VID2CONTEXT_MAX_PLAYLIST_ITEMS: '(built-in limit)',
  VID2CONTEXT_MAX_UPLOAD_MB: '(built-in limit)',
  VID2CONTEXT_MAX_AUDIO_MB: '(built-in limit)',
};

export const MASK = '******** (hidden)';

function isSet(v: string | undefined): v is string {
  return v !== undefined && v !== '';
}

function mask(name: string, value: string): string {
  return isSecretName(name) || looksLikeKey(value) ? MASK : value;
}

function profileSource(r: ResolvedProfile, from: string): string {
  return from === r.name ? `profile ${from}` : `extends ${from}`;
}

/** Every effective setting, its value and where it came from. Works without a config too (env and defaults only). */
export function trace(config: Config | undefined, profileName: string | undefined, env: Env): TraceEntry[] {
  const r = config && profileName ? resolveProfile(config, profileName) : undefined;
  const { entries, missing } = r ? compileProfile(r, env) : { entries: [] as EnvEntry[], missing: [] as MissingRef[] };
  const byName = new Map(entries.map((e) => [e.name, e]));
  const out: TraceEntry[] = [];

  const envLine = (name: string, fallback?: string) => {
    const real = env[name];
    const fromConfig = byName.get(name);
    if (isSet(real)) {
      const overrides = fromConfig && r ? ` (overrides ${profileSource(r, fromConfig.from)})` : '';
      out.push({ setting: name, value: mask(name, real), source: `env ${name}${overrides}` });
    } else if (fromConfig && r) {
      const via = fromConfig.ref ? ` via env ${fromConfig.ref}` : '';
      out.push({ setting: name, value: mask(name, fromConfig.value), source: `${profileSource(r, fromConfig.from)}${via}` });
    } else if (fallback !== undefined) {
      out.push({ setting: name, value: fallback, source: 'default' });
    }
  };

  for (const name of Object.keys(CONTROLLED_ENV)) envLine(name, DEFAULTS[name]);

  if (r) {
    for (const field of ['policy', 'only', 'prefer', 'skip'] as const) {
      const map = r[field] as Partial<Record<StageKey, string | string[]>>;
      for (const stage of ['default', ...STAGES] as StageKey[]) {
        // The default policy and skip list are already shown as env vars above.
        if (stage === 'default' && (field === 'policy' || field === 'skip')) continue;
        const v = map[stage];
        if (v === undefined) continue;
        const from = r.sources[`${field}.${stage}`] ?? r.name;
        const label = stage === 'default' ? `${field} (every stage)` : `${field} (${stage})`;
        out.push({ setting: label, value: Array.isArray(v) ? v.join(', ') || '(empty)' : v, source: profileSource(r, from) });
      }
    }
  }

  const modelVars = [...MODEL_ENV_VARS].filter((n) => isSet(env[n]) || byName.has(n)).sort();
  for (const name of modelVars) envLine(name);

  const extras = r ? Object.keys(r.env) : [];
  for (const name of extras) envLine(name);

  for (const m of missing) {
    out.push({ setting: m.path, value: '(not set)', source: `${r ? profileSource(r, m.from) : 'config'}: env ${m.ref} is unset` });
  }
  return out;
}

/**
 * A readable trace of every effective setting and where it came from, with
 * secret values masked. `vid2context config` prints this.
 */
export function explain(
  config: Config | undefined,
  profileName: string | undefined,
  env: Env,
  opts: { configPath?: string } = {},
): string {
  const lines: string[] = [];
  if (config && profileName) {
    const r = resolveProfile(config, profileName);
    const chain = r.lineage.length > 1 ? ` (extends ${r.lineage.slice(1).join(' -> ')})` : '';
    lines.push(`Profile: ${profileName}${chain}`);
    if (r.description) lines.push(`  ${r.description}`);
    if (opts.configPath) lines.push(`Config: ${opts.configPath}`);
  } else {
    lines.push('No config file: settings come from the environment and built-in defaults.');
  }
  lines.push('Precedence: environment, then config profile, then built-in default.');
  lines.push('');
  const rows = trace(config, profileName, env);
  const w1 = Math.max(7, ...rows.map((x) => x.setting.length));
  const w2 = Math.max(5, ...rows.map((x) => x.value.length));
  lines.push(`${'Setting'.padEnd(w1)}  ${'Value'.padEnd(w2)}  Source`);
  for (const row of rows) lines.push(`${row.setting.padEnd(w1)}  ${row.value.padEnd(w2)}  ${row.source}`);
  return lines.join('\n');
}
