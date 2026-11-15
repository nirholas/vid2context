import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vid2ContextError } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import {
  type Config,
  configJsonSchema,
  explain,
  MASK,
  MODEL_KEYS,
  mergeEnv,
  parseConfig,
  resolveProfile,
  toEnv,
  trace,
  validateConfig,
} from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const fixture = (name: string) => resolve(here, 'fixtures', name);
const load = (path: string): Config => parseConfig(readFileSync(path, 'utf8'), { source: path });
const examples = () => load(resolve(pkg, 'examples/vid2context.config.jsonc'));

function errorOf(fn: () => unknown): Vid2ContextError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Vid2ContextError);
    return err as Vid2ContextError;
  }
  throw new Error('expected an error');
}

describe('parseConfig', () => {
  it('accepts comments and trailing commas without touching strings', () => {
    const c = load(fixture('comments.jsonc'));
    expect(c.profiles.default?.skip).toEqual(['pollinations', 'ovh']);
    expect(c.profiles.default?.env?.NOTE).toBe('a // inside a string is not a comment, nor is /* this */');
  });

  it('reports syntax errors with line and column', () => {
    const err = errorOf(() => parseConfig('{\n  "version": 1,\n  "profiles": { oops }\n}', { source: 'x.json' }));
    expect(err.code).toBe('bad-request');
    expect(err.message).toMatch(/^x\.json: could not parse the config: .*line 3 column \d+/);
  });

  it('reports every schema problem with its JSON path', () => {
    const err = errorOf(() => load(fixture('bad-shape.json')));
    expect(err.code).toBe('bad-request');
    expect(err.message).toContain('version: expected 1, got 2');
    expect(err.message).toContain('profiles.work.policy.stt: expected one of free, local-only, quality, got "cheap"');
    expect(err.message).toContain('profiles.work.allowPaid: expected true or false, got string');
    expect(err.message).toContain('profiles.work.limits.maxAudioMb: expected an integer >= 1, got 0');
    expect(err.message).toMatch(/profiles\.work\.polcy: unknown key; expected one of .*policy/);
    expect(err.hint).toContain('docs/configuration.md');
  });

  it('refuses literal keys and names the field', () => {
    const err = errorOf(() => load(fixture('literal-key.json')));
    expect(err.message).toContain('profiles.default.env.OPENAI_API_KEY');
    expect(err.message).toContain('profiles.default.models.gemini: looks like an API key');
    expect(err.message).toContain('.env');
    expect(err.message).not.toContain('sk-this-is-not-a-real-key');
    expect(err.hint).toMatch(/never in a committed config file/);
  });

  it('refuses unknown model providers and lists the known keys', () => {
    const err = errorOf(() => load(fixture('unknown-provider.json')));
    expect(err.message).toContain('profiles.default.models.grok: unknown key');
    expect(err.message).not.toContain('models.groq:');
    expect(err.hint).toContain('Known models keys: ');
    expect(err.hint).toContain('groq:stt');
  });

  it('detects extends cycles', () => {
    const err = errorOf(() => load(fixture('cycle.json')));
    expect(err.message).toMatch(/extends cycle: (a -> b -> a|b -> a -> b)/);
    expect(err.message.match(/extends cycle/g)).toHaveLength(1);
  });

  it('refuses secret-named env extras unless they reference env', () => {
    const base = { version: 1, profiles: { default: { env: { GITHUB_TOKEN: 'plain' } } } };
    expect(errorOf(() => validateConfig(base)).message).toContain(
      'profiles.default.env.GITHUB_TOKEN: GITHUB_TOKEN holds a secret',
    );
    expect(() =>
      validateConfig({ version: 1, profiles: { default: { env: { GITHUB_TOKEN: 'env:WORK_TOKEN' } } } }),
    ).not.toThrow();
  });

  it('refuses env extras that a profile field controls', () => {
    const err = errorOf(() =>
      validateConfig({ version: 1, profiles: { default: { env: { VID2CONTEXT_POLICY: 'free', GROQ_STT_MODEL: 'x' } } } }),
    );
    expect(err.message).toContain('set policy in the profile instead of VID2CONTEXT_POLICY');
    expect(err.message).toContain('set models.groq:stt in the profile instead of GROQ_STT_MODEL');
  });

  it('checks defaultProfile and extends targets', () => {
    const err = errorOf(() => validateConfig({ version: 1, defaultProfile: 'nope', profiles: { a: { extends: 'gone' } } }));
    expect(err.message).toContain('defaultProfile: no profile named "nope"; profiles: a');
    expect(err.message).toContain('profiles.a.extends: no profile named "gone"');
  });
});

describe('resolveProfile', () => {
  it('applies extends: objects merge, per-stage values merge, lists replace', () => {
    const r = resolveProfile(load(fixture('extends.jsonc')), 'work-strict');
    expect(r.lineage).toEqual(['work-strict', 'work', 'base']);
    expect(r.policy).toEqual({ default: 'free', stt: 'local-only', llm: 'quality' });
    expect(r.keyless).toBe(true);
    expect(r.allowPaid).toBe(false);
    expect(r.skip).toEqual({ default: ['ovh', 'pollinations'], llm: ['ovh'] });
    expect(r.defaults).toEqual({ format: 'markdown', timestamps: false, mode: 'captions', language: 'en', comments: 20 });
    expect(r.limits).toEqual({ maxPlaylistItems: 50, maxAudioMb: 300 });
    expect(r.sources['policy.default']).toBe('base');
    expect(r.sources['policy.stt']).toBe('work');
    expect(r.sources.keyless).toBe('work-strict');
    expect(r.sources['models.groq']).toBe('base');
  });

  it('fails clearly for a missing profile', () => {
    const err = errorOf(() => resolveProfile(examples(), 'fast'));
    expect(err.message).toBe('No profile named "fast" in the config.');
    expect(err.hint).toContain('default, private, quality, hybrid');
  });
});

describe('toEnv', () => {
  it('compiles the default example', () => {
    expect(toEnv(examples(), 'default')).toEqual({
      VID2CONTEXT_POLICY: 'free',
      VID2CONTEXT_ALLOW_PAID: '1',
      VID2CONTEXT_KEYLESS: '1',
    });
  });

  it('compiles the private example', () => {
    expect(toEnv(examples(), 'private')).toEqual({
      VID2CONTEXT_POLICY: 'local-only',
      VID2CONTEXT_ALLOW_PAID: '0',
      VID2CONTEXT_KEYLESS: '0',
    });
  });

  it('compiles the quality example', () => {
    expect(toEnv(examples(), 'quality')).toEqual({
      VID2CONTEXT_POLICY: 'quality',
      VID2CONTEXT_ALLOW_PAID: '1',
      VID2CONTEXT_KEYLESS: '1',
    });
  });

  it('compiles the hybrid example (per-stage policy stays out of env)', () => {
    expect(toEnv(examples(), 'hybrid')).toEqual({
      VID2CONTEXT_POLICY: 'free',
      VID2CONTEXT_ALLOW_PAID: '0',
      VID2CONTEXT_KEYLESS: '0',
    });
  });

  it('ships each built-in profile as its own copy-ready file, identical to the combined example', () => {
    const combined = examples();
    const expected: Record<string, Record<string, string>> = {
      default: { VID2CONTEXT_POLICY: 'free', VID2CONTEXT_ALLOW_PAID: '1', VID2CONTEXT_KEYLESS: '1' },
      private: { VID2CONTEXT_POLICY: 'local-only', VID2CONTEXT_ALLOW_PAID: '0', VID2CONTEXT_KEYLESS: '0' },
      quality: { VID2CONTEXT_POLICY: 'quality', VID2CONTEXT_ALLOW_PAID: '1', VID2CONTEXT_KEYLESS: '1' },
    };
    for (const [name, env] of Object.entries(expected)) {
      const single = load(resolve(pkg, `examples/${name}.config.jsonc`));
      expect(Object.keys(single.profiles)).toEqual([name]);
      expect(single.defaultProfile).toBe(name);
      expect(single.profiles[name]).toEqual(combined.profiles[name]);
      expect(toEnv(single, name)).toEqual(env);
    }
  });

  it('compiles every field of an extended profile and resolves env: references', () => {
    const env = { WORK_CEREBRAS_MODEL: 'llama-3.3-70b', WORK_GROQ_KEY: 'value-from-env' };
    expect(toEnv(load(fixture('extends.jsonc')), 'work', env)).toEqual({
      VID2CONTEXT_POLICY: 'free',
      VID2CONTEXT_ALLOW_PAID: '0',
      VID2CONTEXT_KEYLESS: '0',
      VID2CONTEXT_SKIP: 'pollinations',
      GROQ_MODEL: 'openai/gpt-oss-120b,qwen/qwen3.8-27b',
      OLLAMA_MODEL: 'qwen3:8b',
      GROQ_STT_MODEL: 'whisper-large-v3',
      CEREBRAS_MODEL: 'llama-3.3-70b',
      VID2CONTEXT_STORAGE: 'sqlite',
      VID2CONTEXT_FORMAT: 'markdown',
      VID2CONTEXT_TIMESTAMPS: '1',
      VID2CONTEXT_MODE: 'captions',
      VID2CONTEXT_LANG: 'en',
      VID2CONTEXT_COMMENTS: '20',
      VID2CONTEXT_MAX_PLAYLIST_ITEMS: '50',
      VID2CONTEXT_MAX_AUDIO_MB: '300',
      OLLAMA_BASE_URL: 'http://localhost:11434/v1',
      GROQ_API_KEY: 'value-from-env',
    });
  });

  it('emits nothing for a reference to an unset variable', () => {
    const out = toEnv(load(fixture('extends.jsonc')), 'work', {});
    expect(out).not.toHaveProperty('CEREBRAS_MODEL');
    expect(out).not.toHaveProperty('GROQ_API_KEY');
  });

  it('maps model keys to the documented env names', () => {
    expect(MODEL_KEYS.groq).toBe('GROQ_MODEL');
    expect(MODEL_KEYS['groq:stt']).toBe('GROQ_STT_MODEL');
    expect(MODEL_KEYS['ollama:embed']).toBe('OLLAMA_EMBED_MODEL');
    expect(MODEL_KEYS.local).toBe('LOCAL_LLM_MODEL');
    expect(MODEL_KEYS['local:stt']).toBe('LOCAL_STT_MODEL');
    expect(MODEL_KEYS['gemini:visual']).toBe('GEMINI_VISION_MODEL');
  });
});

describe('precedence', () => {
  const overlay = toEnv(examples(), 'private');

  it('real env beats config', () => {
    const env = mergeEnv({ VID2CONTEXT_POLICY: 'quality' }, overlay);
    expect(env.VID2CONTEXT_POLICY).toBe('quality');
    expect(env.VID2CONTEXT_KEYLESS).toBe('0');
  });

  it('config beats the default (unset or empty env values)', () => {
    const env = mergeEnv({ VID2CONTEXT_POLICY: '', VID2CONTEXT_KEYLESS: undefined }, overlay);
    expect(env.VID2CONTEXT_POLICY).toBe('local-only');
    expect(env.VID2CONTEXT_KEYLESS).toBe('0');
  });

  it('leaves unrelated env alone', () => {
    expect(mergeEnv({ PATH: '/bin' }, overlay).PATH).toBe('/bin');
  });
});

describe('explain', () => {
  it('traces where each setting came from', () => {
    const config = load(fixture('extends.jsonc'));
    const rows = trace(config, 'work-strict', { VID2CONTEXT_SKIP: 'ovh', GROQ_MODEL: 'openai/gpt-oss-20b' });
    const row = (s: string) => rows.find((r) => r.setting === s);
    expect(row('VID2CONTEXT_POLICY')).toEqual({ setting: 'VID2CONTEXT_POLICY', value: 'free', source: 'extends base' });
    expect(row('VID2CONTEXT_KEYLESS')).toEqual({ setting: 'VID2CONTEXT_KEYLESS', value: '1', source: 'profile work-strict' });
    expect(row('VID2CONTEXT_SKIP')?.source).toBe('env VID2CONTEXT_SKIP (overrides profile work-strict)');
    expect(row('GROQ_MODEL')).toEqual({
      setting: 'GROQ_MODEL',
      value: 'openai/gpt-oss-20b',
      source: 'env GROQ_MODEL (overrides extends base)',
    });
    expect(row('policy (stt)')).toEqual({ setting: 'policy (stt)', value: 'local-only', source: 'extends work' });
    expect(row('prefer (every stage)')?.value).toBe('cerebras, groq');
    expect(row('VID2CONTEXT_MAX_UPLOAD_MB')).toEqual({
      setting: 'VID2CONTEXT_MAX_UPLOAD_MB',
      value: '(built-in limit)',
      source: 'default',
    });
    expect(row('models.cerebras')?.source).toBe('extends work: env WORK_CEREBRAS_MODEL is unset');
  });

  it('masks secrets, whether from env or a config reference', () => {
    const config = load(fixture('extends.jsonc'));
    const env = { WORK_GROQ_KEY: 'gsk_abcdefghijklmnop1234', OPENAI_API_KEY: 'plain-secret-value' };
    const text = explain(config, 'work', env);
    expect(text).not.toContain('gsk_abcdefghijklmnop1234');
    const rows = trace(config, 'work', env);
    expect(rows.find((r) => r.setting === 'GROQ_API_KEY')).toEqual({
      setting: 'GROQ_API_KEY',
      value: MASK,
      source: 'profile work via env WORK_GROQ_KEY',
    });
  });

  it('works without a config file', () => {
    const text = explain(undefined, undefined, { VID2CONTEXT_POLICY: 'local-only' });
    expect(text).toContain('No config file');
    expect(text).toMatch(/VID2CONTEXT_POLICY\s+local-only\s+env VID2CONTEXT_POLICY/);
    expect(text).toMatch(/VID2CONTEXT_KEYLESS\s+1\s+default/);
  });

  it('prints a readable trace of the default example', () => {
    const text = explain(examples(), 'default', {}, { configPath: 'examples/vid2context.config.jsonc' });
    expect(text.split('\n').slice(0, 7)).toEqual([
      'Profile: default',
      '  Free first: local, then free tiers with your keys, then keyless hosts, paid only as a keyed backstop.',
      'Config: examples/vid2context.config.jsonc',
      'Precedence: environment, then config profile, then built-in default.',
      '',
      expect.stringMatching(/^Setting\s+Value\s+Source$/),
      expect.stringMatching(/^VID2CONTEXT_POLICY\s+free\s+profile default$/),
    ]);
  });
});

describe('JSON Schema', () => {
  it('the committed schema matches the validator definitions', () => {
    const committed = JSON.parse(readFileSync(resolve(pkg, 'schema/config.schema.json'), 'utf8'));
    expect(committed).toEqual(configJsonSchema());
  });
});

describe('runtime neutrality', () => {
  it('src/index.ts and everything it imports use no node: modules', () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1] as string;
        expect(spec, `${file} imports ${spec}`).not.toMatch(/^node:/);
        expect(spec, `${file} imports ${spec}`).not.toMatch(/^@vid2context\/registry/);
        if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
      }
    };
    visit(resolve(pkg, 'src/index.ts'));
    expect(seen.size).toBeGreaterThan(5);
  });
});
