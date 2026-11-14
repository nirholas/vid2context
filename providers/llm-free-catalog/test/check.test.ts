import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { llmRungs as foundationRungs } from '@vid2context/provider-llm-openai-compatible';
import { describe, expect, it } from 'vitest';
import { type CheckRow, catalogRungs, exitCodeFor, formatTable, isCorrect, runChecks, selectRungs } from '../src/index.ts';

// Real answers to the check:llm prompt, recorded 2026-11-14 (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const KILO = 'https://api.kilo.ai/api/gateway/chat/completions';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const CF = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`;

describe('selectRungs', () => {
  const env: Env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'cf_a', OPENAI_API_KEY: 'sk-a' };
  const all = [...foundationRungs(env), ...catalogRungs(env)];

  it('takes every enabled rung and skips paid ones unless asked', () => {
    const { run, skipped } = selectRungs(all, env);
    expect(run.map((r) => r.service)).toEqual(['ovh', 'ovh', 'pollinations', 'kilo', 'kilo', 'kilo', 'cloudflare']);
    expect(skipped).toEqual([{ id: 'llm/openai/gpt-5.4-nano', why: 'paid (pass --include-paid)' }]);
    expect(selectRungs(all, env, { includePaid: true }).run.map((r) => r.id)).toContain('llm/openai/gpt-5.4-nano');
  });

  it('filters by id, service, provider or id prefix', () => {
    expect(selectRungs(all, env, { only: ['llm/kilo'] }).run.map((r) => r.service)).toEqual(['kilo', 'kilo', 'kilo']);
    expect(selectRungs(all, env, { only: ['llm-free-catalog'], skip: ['kilo'] }).run.map((r) => r.service)).toEqual([
      'cloudflare',
    ]);
    expect(selectRungs(all, { ...env, VID2CONTEXT_KEYLESS: '0' }).run.map((r) => r.service)).toEqual(['cloudflare']);
  });
});

describe('runChecks', () => {
  it('calls each rung once and grades the answer', async () => {
    const env: Env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'cf_a' };
    const fetch = replayFetch([
      { url: CF, response: { body: fixture('cloudflare-llama-3.3-70b.check.json') } },
      {
        url: KILO,
        response: (call) => {
          const model = (JSON.parse(String(call.body)) as { model: string }).model;
          if (model === 'nvidia/nemotron-3-ultra-550b-a55b:free') return { body: fixture('kilo-nemotron-3-ultra.check.json') };
          if (model === 'nvidia/nemotron-3.5-super-vl:free')
            return { body: fixture('kilo-nemotron-3.5-super-vl.reasoning.json') };
          return { status: 404, body: fixture('kilo-404-retired-model.json') };
        },
      },
    ]);
    const { run } = selectRungs(catalogRungs(env), env);
    const rows = await runChecks(run, testContext({ fetch, env }), { concurrency: 2 });
    expect(rows.map((r) => [r.id, r.outcome, r.code, r.correct])).toEqual([
      ['llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free', 'ok', undefined, true],
      // A recorded answer to a different question: it answered, but not 42.
      ['llm/kilo/nvidia/nemotron-3.5-super-vl:free', 'ok', undefined, false],
      ['llm/kilo/nvidia/nemotron-3.5-lightning:free', 'error', 'not-found-404', false],
      ['llm/cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'ok', undefined, true],
    ]);
    expect(rows[2]?.reason).toMatch(/^kilo chat: HTTP 404/);
    expect(fetch.calls).toHaveLength(4);
    expect(JSON.parse(String(fetch.calls[0]?.body))).toMatchObject({
      messages: [{ role: 'user', content: 'What is 17 plus 25? Reply with the number only.' }],
      max_tokens: 400,
    });
    expect(exitCodeFor(rows)).toBe(0);
  });

  it('redacts keys from failure reasons and exits 1 when nothing answered', async () => {
    const env: Env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'cf_token_value_123456', VID2CONTEXT_KEYLESS: '0' };
    const fetch = replayFetch([{ url: CF, response: { status: 401, body: fixture('cloudflare-401.json') } }]);
    const rows = await runChecks(selectRungs(catalogRungs(env), env).run, testContext({ fetch, env }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'error', code: 'auth-401', correct: false });
    expect(rows[0]?.reason).toContain('Authentication error');
    expect(exitCodeFor(rows)).toBe(1);
    expect(exitCodeFor([])).toBe(1);
  });
});

describe('formatting', () => {
  const rows: CheckRow[] = [
    {
      id: 'llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free',
      tier: 'keyless',
      service: 'kilo',
      model: 'm',
      ms: 1080,
      outcome: 'ok',
      correct: true,
    },
    {
      id: 'llm/openrouter/free-auto',
      tier: 'free',
      service: 'openrouter',
      model: 'free-auto',
      answeredBy: 'google/gemma-4-31b-it:free',
      ms: 950,
      outcome: 'ok',
      correct: false,
    },
    {
      id: 'llm/ovh/gpt-oss-120b',
      tier: 'keyless',
      service: 'ovh',
      model: 'gpt-oss-120b',
      ms: 45000,
      outcome: 'error',
      code: 'timeout',
      reason: 'The operation was aborted due to timeout',
      correct: false,
    },
  ];

  it('prints an aligned table with a summary line', () => {
    expect(formatTable(rows, [{ id: 'llm/openai/gpt-5.4-nano', why: 'paid (pass --include-paid)' }])).toBe(
      [
        'rung                                                   tier     service     ms     correct  outcome',
        'llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free        keyless  kilo        1080   yes      ok',
        'llm/openrouter/free-auto (google/gemma-4-31b-it:free)  free     openrouter  950    no       ok',
        'llm/ovh/gpt-oss-120b                                   keyless  ovh         45000  -        timeout: The operation was aborted due to timeout',
        '',
        '2 of 3 rungs answered, 1 correctly.',
        'skipped llm/openai/gpt-5.4-nano: paid (pass --include-paid)',
      ].join('\n'),
    );
  });

  it('grades only an answer of exactly 42', () => {
    expect(isCorrect('42')).toBe(true);
    expect(isCorrect('The answer is 42.')).toBe(true);
    expect(isCorrect('41 or 42')).toBe(false);
    expect(isCorrect('forty-two')).toBe(false);
  });
});
