import { describe, expect, it } from 'vitest';
import { browserCorsFor, MEASURED_CORS } from '../src/lib/cors.ts';
import { autoPick, filterModels, formatContextTokens, groupModels, serviceLabel, toModelRows } from '../src/lib/models.ts';
import { browserModels, fixtureJson, serverModels } from './helpers.ts';

describe('model rows from the real GET /api/v1/models response (server mode)', () => {
  const rows = toModelRows(serverModels(), 'server');

  it('says what a disabled row needs, by env var name', () => {
    const groq = rows.find((r) => r.id === 'llm/groq/openai/gpt-oss-120b');
    expect(groq?.enabled).toBe(false);
    expect(groq?.disabledReason).toBe('Needs GROQ_API_KEY');
    const ollama = rows.find((r) => r.service === 'ollama');
    expect(ollama?.label).toBe('Ollama (set a model)');
    expect(ollama?.disabledReason).toBe('Needs OLLAMA_MODEL');
  });

  it('keeps enabled rows enabled and never invents a reason for them', () => {
    const enabled = rows.filter((r) => r.enabled);
    expect(enabled.length).toBeGreaterThan(0);
    expect(enabled.every((r) => r.disabledReason === undefined)).toBe(true);
  });

  it('groups tiers free-first and services in the order the server ranked them', () => {
    const groups = groupModels(rows);
    expect(groups.map((g) => g.tier)).toEqual(['local', 'free', 'keyless', 'paid']);
    const free = groups.find((g) => g.tier === 'free');
    const order = [...new Set(rows.filter((r) => r.tier === 'free').map((r) => r.service.replace(/#\d+$/, '')))];
    expect(free?.services.map((s) => s.service)).toEqual(order);
    expect(groups.flatMap((g) => g.services.flatMap((s) => s.models)).length).toBe(rows.length);
  });

  it('Auto would start with the first enabled rung in tier order', () => {
    const pick = autoPick(rows);
    const firstEnabledTier = ['local', 'free', 'keyless', 'paid'].find((t) => rows.some((r) => r.tier === t && r.enabled));
    expect(pick?.tier).toBe(firstEnabledTier);
    expect(pick?.enabled).toBe(true);
  });
});

describe('model rows in client-only mode (real browser registry output)', () => {
  const rows = toModelRows(browserModels('nokeys'), 'client', {});

  it('disables services whose API blocks browser requests, with the reason', () => {
    for (const service of ['cerebras', 'github', 'kilo', 'anthropic']) {
      const r = rows.find((x) => x.service === service);
      expect(r, service).toBeDefined();
      expect(r?.enabled).toBe(false);
      expect(r?.disabledReason).toMatch(/CORS/);
    }
    const binding = rows.find((x) => x.service === 'cloudflare-binding');
    expect(binding?.disabledReason).toBe('Runs only inside a Cloudflare Worker.');
  });

  it('keeps browser-callable keyless rungs enabled', () => {
    const ovh = rows.filter((x) => x.service === 'ovh');
    expect(ovh.length).toBe(2);
    expect(ovh.every((r) => r.enabled)).toBe(true);
  });

  it('names only the missing variables, and hints local servers need CORS', () => {
    const local = rows.find((x) => x.service === 'local');
    expect(local?.disabledReason).toBe('Needs LOCAL_LLM_MODEL, LOCAL_LLM_BASE_URL');
    const withBase = toModelRows(browserModels('nokeys'), 'client', { LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8080/v1' });
    expect(withBase.find((x) => x.service === 'local')?.disabledReason).toBe('Needs LOCAL_LLM_MODEL');
    expect(browserCorsFor('ollama', 'llm-local', 'local')).toMatchObject({ status: 'needs-config' });
    expect(browserCorsFor('webllm', 'llm-browser', 'local')).toEqual({ status: 'allowed' });
  });

  it('enables pooled Groq keys as separate rows', () => {
    const groq = toModelRows(browserModels('groq'), 'client', { GROQ_API_KEY: 'x', GROQ_FALLBACK_KEYS: 'y' });
    const services = new Set(groq.filter((r) => r.service.startsWith('groq') && r.enabled).map((r) => r.service));
    expect(services).toEqual(new Set(['groq', 'groq#2']));
    expect(serviceLabel('groq#2')).toBe('Groq (key 2)');
  });
});

describe('the CORS table matches the recorded probe', () => {
  it('has the measured status for every probed service', () => {
    const probe = fixtureJson<{ results: { service: string; cors: string }[] }>('cors-probe.json');
    for (const r of probe.results) expect(MEASURED_CORS[r.service], r.service).toBe(r.cors);
  });
});

describe('search', () => {
  const rows = toModelRows(serverModels(), 'server');
  it('matches every term against label, service and capability', () => {
    const hits = filterModels(rows, 'gpt-oss ovh');
    expect(hits.map((r) => r.id)).toEqual(['llm/ovh/gpt-oss-120b']);
    expect(filterModels(rows, 'Groq').every((r) => r.service.startsWith('groq'))).toBe(true);
    expect(filterModels(rows, 'stream').every((r) => r.capabilities.includes('stream'))).toBe(true);
    expect(filterModels(rows, 'keyless').every((r) => r.tier === 'keyless')).toBe(true);
    expect(filterModels(rows, 'no-such-model')).toEqual([]);
  });
});

describe('context badges', () => {
  it('formats windows the way the picker shows them', () => {
    expect(formatContextTokens(131_072)).toBe('128K');
    expect(formatContextTokens(65_536)).toBe('64K');
    expect(formatContextTokens(1_048_576)).toBe('1M');
    expect(formatContextTokens(1_000_000)).toBe('1M');
    expect(formatContextTokens(8000)).toBe('8K');
    expect(formatContextTokens(undefined)).toBeUndefined();
  });
});
