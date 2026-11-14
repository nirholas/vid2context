import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vid2ContextError } from '@vid2context/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findConfigFile, loadConfiguredEnv } from '../src/node.ts';

const here = dirname(fileURLToPath(import.meta.url));
const example = resolve(here, '../examples/vid2context.config.jsonc');

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'v2c-config-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'v2c-config-home-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('findConfigFile', () => {
  it('searches cwd json, cwd jsonc, then XDG', () => {
    const where = findConfigFile({ HOME: home }, dir);
    expect(where.path).toBeUndefined();
    expect(where.searched).toEqual([
      join(dir, 'vid2context.config.json'),
      join(dir, 'vid2context.config.jsonc'),
      join(home, '.config', 'vid2context', 'config.json'),
    ]);
  });

  it('prefers ./vid2context.config.json over .jsonc and XDG', () => {
    mkdirSync(join(home, '.config', 'vid2context'), { recursive: true });
    copyFileSync(example, join(home, '.config', 'vid2context', 'config.json'));
    copyFileSync(example, join(dir, 'vid2context.config.jsonc'));
    expect(findConfigFile({ HOME: home }, dir).path).toBe(join(dir, 'vid2context.config.jsonc'));
    copyFileSync(example, join(dir, 'vid2context.config.json'));
    expect(findConfigFile({ HOME: home }, dir).path).toBe(join(dir, 'vid2context.config.json'));
  });

  it('a missing VID2CONTEXT_CONFIG file is an error', () => {
    expect(() => findConfigFile({ VID2CONTEXT_CONFIG: 'missing.json' }, dir)).toThrow(Vid2ContextError);
  });
});

describe('loadConfiguredEnv', () => {
  it('no config file returns the env unchanged', async () => {
    const env = { HOME: home, VID2CONTEXT_POLICY: 'quality' };
    const out = await loadConfiguredEnv({ cwd: dir, env });
    expect(out.env).toEqual(env);
    expect(out.profile).toBeUndefined();
    expect(out.configPath).toBeUndefined();
    expect(out.chainOptionsFor('llm')).toEqual({ prefer: [] });
    expect(out.explain).toContain('No config file');
  });

  it('asking for a profile without a config file is an error', async () => {
    await expect(loadConfiguredEnv({ cwd: dir, env: { HOME: home }, profile: 'private' })).rejects.toThrow(
      /no config file was found/,
    );
  });

  it('loads VID2CONTEXT_CONFIG relative to cwd and reports the path', async () => {
    copyFileSync(example, join(dir, 'team.jsonc'));
    const out = await loadConfiguredEnv({ cwd: dir, env: { HOME: home, VID2CONTEXT_CONFIG: 'team.jsonc' } });
    expect(out.configPath).toBe(join(dir, 'team.jsonc'));
    expect(out.profile).toBe('default');
    expect(out.env.VID2CONTEXT_POLICY).toBe('free');
  });

  it('loads the XDG config and selects profiles in order: argument, VID2CONTEXT_PROFILE, defaultProfile', async () => {
    const xdg = join(home, 'xdg');
    mkdirSync(join(xdg, 'vid2context'), { recursive: true });
    copyFileSync(example, join(xdg, 'vid2context', 'config.json'));
    const env = { HOME: home, XDG_CONFIG_HOME: xdg };
    const byDefault = await loadConfiguredEnv({ cwd: dir, env });
    expect(byDefault.configPath).toBe(join(xdg, 'vid2context', 'config.json'));
    expect(byDefault.profile).toBe('default');
    const byEnv = await loadConfiguredEnv({ cwd: dir, env: { ...env, VID2CONTEXT_PROFILE: 'quality' } });
    expect(byEnv.profile).toBe('quality');
    expect(byEnv.env.VID2CONTEXT_POLICY).toBe('quality');
    const byArg = await loadConfiguredEnv({ cwd: dir, env: { ...env, VID2CONTEXT_PROFILE: 'quality' }, profile: 'private' });
    expect(byArg.profile).toBe('private');
    expect(byArg.env).toMatchObject({ VID2CONTEXT_POLICY: 'local-only', VID2CONTEXT_KEYLESS: '0', VID2CONTEXT_ALLOW_PAID: '0' });
  });

  it('falls back to the profile named default when defaultProfile is absent', async () => {
    writeFileSync(
      join(dir, 'vid2context.config.json'),
      JSON.stringify({ version: 1, profiles: { default: { policy: 'quality' } } }),
    );
    const out = await loadConfiguredEnv({ cwd: dir, env: { HOME: home } });
    expect(out.profile).toBe('default');
    expect(out.env.VID2CONTEXT_POLICY).toBe('quality');
  });

  it('real env wins over the profile, in env, chain options and explain', async () => {
    copyFileSync(example, join(dir, 'vid2context.config.jsonc'));
    const out = await loadConfiguredEnv({ cwd: dir, env: { HOME: home, VID2CONTEXT_POLICY: 'quality' }, profile: 'hybrid' });
    expect(out.env.VID2CONTEXT_POLICY).toBe('quality');
    expect(out.chainOptionsFor('llm')).toEqual({ allowPaid: false, prefer: ['groq', 'cerebras'] });
    expect(out.chainOptionsFor('stt')).toEqual({ policy: 'local-only', allowPaid: false, prefer: [] });
    expect(out.explain).toMatch(/VID2CONTEXT_POLICY\s+quality\s+env VID2CONTEXT_POLICY \(overrides profile hybrid\)/);
  });

  it('loads .env from cwd before compiling, so env: references resolve (shell still wins)', async () => {
    const saved = { ...process.env };
    try {
      delete process.env.VID2CONTEXT_ENV_FILE;
      delete process.env.VID2CONTEXT_CONFIG;
      delete process.env.VID2CONTEXT_PROFILE;
      delete process.env.V2C_TEST_OLLAMA_MODEL;
      process.env.HOME = home;
      delete process.env.XDG_CONFIG_HOME;
      writeFileSync(join(dir, '.env'), 'V2C_TEST_OLLAMA_MODEL=qwen3:8b\n');
      writeFileSync(
        join(dir, 'vid2context.config.json'),
        JSON.stringify({ version: 1, profiles: { default: { models: { ollama: 'env:V2C_TEST_OLLAMA_MODEL' } } } }),
      );
      const out = await loadConfiguredEnv({ cwd: dir });
      expect(out.envFiles).toEqual([join(dir, '.env')]);
      expect(out.env.OLLAMA_MODEL ?? '').toBe(saved.OLLAMA_MODEL || 'qwen3:8b');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
