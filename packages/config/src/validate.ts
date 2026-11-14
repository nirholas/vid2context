import { Vid2ContextError } from '@vid2context/core';
import { type Config, configSchema, ENV_REF } from './definition.ts';
import { parseJsonc } from './jsonc.ts';
import { MODEL_ENV_VARS, MODEL_KEYS } from './models.ts';
import { check, joinPath, type SchemaError } from './schema.ts';

export const DOCS_HINT = 'See docs/configuration.md for the file format and examples.';

/** Env var names that hold secrets. Their values never live in a config file. */
const SECRET_NAME = /(?:^|_)(?:KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWORD_HASH)$/;
/** Known key prefixes (OpenAI, Anthropic, Groq, Google, GitHub, Hugging Face), followed by key-like characters. */
const KEY_LIKE = /(?:^|[\s,;:="'])(?:sk-ant-|sk-|gsk_|AIza|ghp_|github_pat_|hf_)[A-Za-z0-9_-]{8,}/;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function looksLikeKey(value: string): boolean {
  return KEY_LIKE.test(value);
}

/**
 * Env names that structured profile fields control. `env` extras may not set
 * them, so each setting has exactly one place in a profile (and explain can
 * say where it came from).
 */
export const CONTROLLED_ENV: Readonly<Record<string, string>> = {
  VID2CONTEXT_POLICY: 'policy',
  VID2CONTEXT_ALLOW_PAID: 'allowPaid',
  VID2CONTEXT_KEYLESS: 'keyless',
  VID2CONTEXT_SKIP: 'skip',
  VID2CONTEXT_STORAGE: 'storage',
  VID2CONTEXT_FORMAT: 'defaults.format',
  VID2CONTEXT_TIMESTAMPS: 'defaults.timestamps',
  VID2CONTEXT_MODE: 'defaults.mode',
  VID2CONTEXT_LANG: 'defaults.language',
  VID2CONTEXT_COMMENTS: 'defaults.comments',
  VID2CONTEXT_MAX_PLAYLIST_ITEMS: 'limits.maxPlaylistItems',
  VID2CONTEXT_MAX_UPLOAD_MB: 'limits.maxUploadMb',
  VID2CONTEXT_MAX_AUDIO_MB: 'limits.maxAudioMb',
};

/** Read before the config is loaded, so setting them from a profile would do nothing. */
const LOADER_ENV = ['VID2CONTEXT_CONFIG', 'VID2CONTEXT_PROFILE', 'VID2CONTEXT_ENV_FILE'];

function scanSecrets(value: unknown, path: string, errors: SchemaError[]): void {
  if (typeof value === 'string') {
    if (looksLikeKey(value)) {
      errors.push({ path, message: 'looks like an API key. Secrets never go in a config file: put the key in .env' });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      scanSecrets(v, `${path}[${i}]`, errors);
    });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scanSecrets(v, joinPath(path, k), errors);
  }
}

function semanticErrors(config: Config): SchemaError[] {
  const errors: SchemaError[] = [];
  const names = Object.keys(config.profiles);
  if (config.defaultProfile !== undefined && !names.includes(config.defaultProfile)) {
    errors.push({
      path: 'defaultProfile',
      message: `no profile named ${JSON.stringify(config.defaultProfile)}; profiles: ${names.join(', ') || '(none)'}`,
    });
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    const base = joinPath('profiles', name);
    if (profile.extends !== undefined && !names.includes(profile.extends)) {
      errors.push({ path: `${base}.extends`, message: `no profile named ${JSON.stringify(profile.extends)}` });
    }
    for (const [key, value] of Object.entries(profile.env ?? {})) {
      const at = joinPath(`${base}.env`, key);
      const isRef = value.startsWith('env:');
      if (isRef && !new RegExp(ENV_REF).test(value)) {
        errors.push({ path: at, message: `${JSON.stringify(value)} is not a valid reference; write "env:NAME"` });
      } else if (isSecretName(key) && !isRef) {
        errors.push({
          path: at,
          message: `${key} holds a secret. Put it in .env, or reference another variable with "env:NAME"`,
        });
      }
      if (CONTROLLED_ENV[key]) {
        errors.push({ path: at, message: `set ${CONTROLLED_ENV[key]} in the profile instead of ${key}` });
      } else if (MODEL_ENV_VARS.has(key)) {
        const modelKey = Object.entries(MODEL_KEYS).find(([, v]) => v === key)?.[0];
        errors.push({ path: at, message: `set models.${modelKey} in the profile instead of ${key}` });
      } else if (LOADER_ENV.includes(key)) {
        errors.push({ path: at, message: `${key} is read before the config loads; set it in the shell or .env` });
      }
    }
    for (const [key, value] of Object.entries(profile.models ?? {})) {
      const at = joinPath(`${base}.models`, key);
      if (typeof value === 'string' && value.startsWith('env:') && !new RegExp(ENV_REF).test(value)) {
        errors.push({ path: at, message: `${JSON.stringify(value)} is not a valid reference; write "env:NAME"` });
      }
      if (Array.isArray(value)) {
        value.forEach((m, i) => {
          if (m.startsWith('env:')) errors.push({ path: `${at}[${i}]`, message: 'an "env:NAME" reference must be the whole value' });
          if (m.includes(',')) errors.push({ path: `${at}[${i}]`, message: 'a model id in a list cannot contain a comma' });
        });
      }
    }
  }
  // extends cycles
  const reported = new Set<string>();
  for (const start of names) {
    const seen: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && config.profiles[cur]) {
      if (seen.includes(cur)) {
        const cycle = [...seen.slice(seen.indexOf(cur)), cur];
        const key = [...cycle].sort().join(',');
        if (!reported.has(key)) {
          reported.add(key);
          errors.push({ path: joinPath('profiles', cur) + '.extends', message: `extends cycle: ${cycle.join(' -> ')}` });
        }
        break;
      }
      seen.push(cur);
      cur = config.profiles[cur]?.extends;
    }
  }
  return errors;
}

function fail(errors: SchemaError[], source: string | undefined): never {
  const where = source ? `${source}: ` : '';
  const lines = errors.map((e) => `  ${e.path}: ${e.message}`);
  const unknownModel = errors.some((e) => /\.models\.[^.]+$/.test(e.path) && e.message.startsWith('unknown key'));
  const secret = errors.some((e) => /secret|API key/.test(e.message));
  const hints = [DOCS_HINT];
  if (secret) hints.unshift('Keys belong in .env or your platform secret store, never in a committed config file.');
  if (unknownModel) hints.push(`Known models keys: ${Object.keys(MODEL_KEYS).join(', ')}.`);
  throw new Vid2ContextError(
    'bad-request',
    `${where}invalid vid2context config (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n${lines.join('\n')}`,
    { hint: hints.join(' ') },
  );
}

/**
 * Check a parsed value against the version 1 schema, plus the rules a schema
 * cannot express (no secrets, extends targets exist and form no cycle).
 * Throws one `bad-request` error listing every problem with its JSON path.
 */
export function validateConfig(value: unknown, opts: { source?: string } = {}): Config {
  const errors = check(configSchema, value);
  const secretErrors: SchemaError[] = [];
  scanSecrets(value, '', secretErrors);
  const pathsWithErrors = new Set(errors.map((e) => e.path));
  errors.push(...secretErrors.filter((e) => !pathsWithErrors.has(e.path)));
  if (errors.length === 0) errors.push(...semanticErrors(value as Config));
  if (errors.length > 0) fail(errors, opts.source);
  return value as Config;
}

/** Parse JSONC text (comments and trailing commas allowed) and validate it. */
export function parseConfig(text: string, opts: { source?: string } = {}): Config {
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch (err) {
    const where = opts.source ? `${opts.source}: ` : '';
    throw new Vid2ContextError('bad-request', `${where}could not parse the config: ${(err as Error).message}`, {
      hint: `The file must be JSON; comments and trailing commas are allowed. ${DOCS_HINT}`,
      cause: err,
    });
  }
  return validateConfig(value, opts);
}
