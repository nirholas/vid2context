import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ModelInfo } from '../src/main.ts';
import { cli, ROOT } from './helpers.ts';

// Key-shaped values: the tests assert none of them ever reaches output.
const SECRETS = {
  GROQ_API_KEY: 'gsk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
  OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
  MISTRAL_API_KEY: 'mistral0123456789abcdefghijklmnop',
};

const tmp = mkdtempSync(join(tmpdir(), 'v2c-config-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('models', () => {
  it('groups rungs by tier with names of missing env vars only', async () => {
    const res = await cli(['models', '--kind', 'stt'], { env: { GROQ_API_KEY: SECRETS.GROQ_API_KEY } });
    expect(res.code).toBe(0);
    const tiers = res.stdout.split('\n').filter((l) => /^\w/.test(l));
    expect(tiers.map((t) => t.split(' ')[0])).toEqual(['local', 'free', 'keyless', 'paid']);
    expect(res.stdout).toMatch(/stt\/groq\/whisper-large-v3-turbo +enabled/);
    expect(res.stdout).toMatch(/stt\/openai\/whisper-1 +disabled +needs OPENAI_API_KEY/);
  });

  it('never prints env values, in text or JSON', async () => {
    for (const argv of [['models'], ['models', '--json']]) {
      const res = await cli(argv, { env: SECRETS });
      for (const v of Object.values(SECRETS)) {
        expect(res.stdout).not.toContain(v);
        expect(res.stderr).not.toContain(v);
      }
    }
  });

  it('returns ModelInfo rows and reports keyless lanes turned off', async () => {
    const rows = JSON.parse((await cli(['models', '--json'], { env: { VID2CONTEXT_KEYLESS: '0' } })).stdout) as ModelInfo[];
    const ovh = rows.find((r) => r.id === 'stt/ovh/whisper-large-v3-turbo');
    expect(ovh).toMatchObject({ kind: 'stt', tier: 'keyless', service: 'ovh', label: 'whisper-large-v3-turbo', enabled: false });
    expect(ovh?.missing).toEqual(['VID2CONTEXT_KEYLESS']);
    expect((await cli(['models', '--kind', 'tts'])).code).toBe(2);
  });
});

describe('config', () => {
  it('shows env-driven settings and the storage backend, masking secrets', async () => {
    const env = {
      ...SECRETS,
      HOME: tmp,
      XDG_CONFIG_HOME: tmp,
      VID2CONTEXT_POLICY: 'quality',
      VID2CONTEXT_SKIP: 'groq',
      GROQ_MODEL: 'openai/gpt-oss-120b',
    };
    const res = await cli(['config'], { env, cwd: tmp });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('No config file');
    expect(res.stdout).toMatch(/VID2CONTEXT_POLICY +quality +env VID2CONTEXT_POLICY/);
    expect(res.stdout).toMatch(/VID2CONTEXT_ALLOW_PAID +1 +default/);
    expect(res.stdout).toContain('Storage backend: memory');
    const json = await cli(['config', '--json'], { env, cwd: tmp });
    const report = JSON.parse(json.stdout);
    expect(report.storage).toMatchObject({ backend: 'memory', persistent: false });
    for (const out of [res.stdout, json.stdout]) for (const v of Object.values(SECRETS)) expect(out).not.toContain(v);
  });

  it('explains a profile from the example config file', async () => {
    const env = {
      HOME: tmp,
      XDG_CONFIG_HOME: tmp,
      VID2CONTEXT_CONFIG: join(ROOT, 'packages/config/examples/vid2context.config.jsonc'),
    };
    const dflt = await cli(['config'], { env, cwd: tmp });
    expect(dflt.code).toBe(0);
    expect(dflt.stdout.split('\n')[0]).toBe('Profile: default');
    const priv = JSON.parse((await cli(['config', '--profile', 'private', '--json'], { env, cwd: tmp })).stdout);
    expect(priv).toMatchObject({ profile: 'private', configPath: env.VID2CONTEXT_CONFIG });
    expect(priv.settings.find((s: { setting: string }) => s.setting === 'VID2CONTEXT_POLICY').value).toBe('local-only');
  });

  it('fails with a hint when --profile is given without a config file', async () => {
    const res = await cli(['config', '--profile', 'work'], { env: { HOME: tmp, XDG_CONFIG_HOME: tmp }, cwd: tmp });
    expect(res.code).toBe(15);
    expect(res.stderr).toContain('hint: Create one of');
  });
});
