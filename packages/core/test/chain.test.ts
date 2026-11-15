import { beforeEach, describe, expect, it } from 'vitest';
import { attemptsOf, clearCooldowns, rankRungs, runChain } from '../src/chain.ts';
import { Vid2ContextError } from '../src/errors.ts';
import type { Rung } from '../src/provider.ts';
import { testContext } from '../src/testing.ts';
import type { Tier } from '../src/types.ts';

type TestRung = Rung & { run: () => Promise<string> };

function rung(id: string, tier: Tier, extra: Partial<TestRung> = {}): TestRung {
  return {
    id,
    provider: 'test',
    service: id.split('/')[0] ?? id,
    model: id,
    tier,
    priority: 0,
    quality: 3,
    capabilities: [],
    requires: [],
    run: async () => id,
    ...extra,
  };
}

const ids = (rs: Rung[]) => rs.map((r) => r.id);

beforeEach(() => clearCooldowns());

describe('rankRungs', () => {
  const rungs = [
    rung('paid/a', 'paid', { quality: 5 }),
    rung('keyless/a', 'keyless', { quality: 2 }),
    rung('free/b', 'free', { priority: 2, quality: 4 }),
    rung('free/a', 'free', { priority: 1, quality: 3 }),
    rung('local/a', 'local', { quality: 1 }),
  ];

  it('orders local, free, keyless, paid by default, then priority', () => {
    expect(ids(rankRungs(rungs, {}, {}))).toEqual(['local/a', 'free/a', 'free/b', 'keyless/a', 'paid/a']);
  });

  it('orders by quality under the quality policy, tier breaking ties', () => {
    expect(ids(rankRungs(rungs, { policy: 'quality' }, {}))).toEqual(['paid/a', 'free/b', 'free/a', 'keyless/a', 'local/a']);
  });

  it('keeps only local rungs under local-only, including from env', () => {
    expect(ids(rankRungs(rungs, {}, { VID2CONTEXT_POLICY: 'local-only' }))).toEqual(['local/a']);
  });

  it('drops paid rungs when paid is disallowed and keyless rungs when keyless is off', () => {
    const env = { VID2CONTEXT_ALLOW_PAID: '0', VID2CONTEXT_KEYLESS: '0' };
    expect(ids(rankRungs(rungs, {}, env))).toEqual(['local/a', 'free/a', 'free/b']);
  });

  it('skips by id, service or provider and filters by capability', () => {
    const withCaps = [...rungs, rung('free/json', 'free', { capabilities: ['json'], priority: 3 })];
    expect(ids(rankRungs(withCaps, { needs: ['json'] }, {}))).toEqual(['free/json']);
    expect(ids(rankRungs(rungs, {}, { VID2CONTEXT_SKIP: 'local, keyless/a' }))).toEqual(['free/a', 'free/b', 'paid/a']);
  });

  it('omits rungs whose required env vars are missing', () => {
    const keyed = rung('free/keyed', 'free', { requires: ['SOME_KEY'] });
    expect(ids(rankRungs([keyed], {}, {}))).toEqual([]);
    expect(ids(rankRungs([keyed], {}, { SOME_KEY: 'k' }))).toEqual(['free/keyed']);
  });
});

describe('runChain', () => {
  it('falls through failures and records every attempt', async () => {
    const rungs = [
      rung('local/a', 'local', {
        run: async () => {
          throw new Vid2ContextError('upstream', 'boom', { status: 500 });
        },
      }),
      rung('free/a', 'free'),
    ];
    const res = await runChain('llm', rungs, (r) => r.run(), {}, testContext());
    expect(res.value).toBe('free/a');
    expect(res.attempts.map((a) => [a.id, a.outcome, a.reason])).toEqual([
      ['local/a', 'error', 'upstream-500'],
      ['free/a', 'ok', undefined],
    ]);
  });

  it('stops at once on caller input errors', async () => {
    const rungs = [
      rung('local/a', 'local', {
        run: async () => {
          throw new Vid2ContextError('bad-request', 'bad input');
        },
      }),
      rung('free/a', 'free'),
    ];
    await expect(runChain('llm', rungs, (r) => r.run(), {}, testContext())).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('cools down a rate-limited rung for the next request', async () => {
    let calls = 0;
    const limited = rung('free/limited', 'free', {
      run: async () => {
        calls++;
        throw new Vid2ContextError('rate-limited', 'slow down', { status: 429, retryAfterSec: 30 });
      },
    });
    const backup = rung('keyless/a', 'keyless');
    await runChain('llm', [limited, backup], (r) => r.run(), {}, testContext());
    const second = await runChain('llm', [limited, backup], (r) => r.run(), {}, testContext());
    expect(calls).toBe(1);
    expect(second.attempts[0]).toMatchObject({ id: 'free/limited', outcome: 'skipped', reason: 'cooldown' });
  });

  it('keys cooldowns by credential, so a rejected key does not cool the rung down for a different key', async () => {
    const used: string[] = [];
    const keyed = rung('free/keyed', 'free', { requires: ['SOME_API_KEY'] });
    const call = (ctx: ReturnType<typeof testContext>) => async () => {
      used.push(ctx.env.SOME_API_KEY ?? '');
      if (ctx.env.SOME_API_KEY === 'rejected') throw new Vid2ContextError('auth', 'invalid key', { status: 401 });
      return 'ok';
    };
    const bad = testContext({ env: { SOME_API_KEY: 'rejected' } });
    await expect(runChain('stt', [{ ...keyed, run: call(bad) }], (r) => r.run(), {}, bad)).rejects.toMatchObject({
      code: 'all-rungs-failed',
    });
    const good = testContext({ env: { SOME_API_KEY: 'accepted' } });
    const res = await runChain('stt', [{ ...keyed, run: call(good) }], (r) => r.run(), {}, good);
    expect(res.value).toBe('ok');
    const again = await runChain('stt', [{ ...keyed, run: call(bad) }], (r) => r.run(), {}, bad).catch((e: unknown) => e);
    expect(attemptsOf(again)[0]).toMatchObject({ id: 'free/keyed', outcome: 'skipped', reason: 'cooldown' });
    expect(used).toEqual(['rejected', 'accepted']);
  });

  it('names the failed stage on no-provider and all-rungs-failed', async () => {
    await expect(runChain('stt', [], async () => 'x', {}, testContext())).rejects.toMatchObject({ stage: 'stt' });
    const failing = rung('free/a', 'free', {
      run: async () => {
        throw new Error('network down');
      },
    });
    await expect(runChain('llm', [failing], (r) => r.run(), {}, testContext())).rejects.toMatchObject({
      code: 'all-rungs-failed',
      stage: 'llm',
    });
  });

  it('throws no-provider when nothing is enabled and all-rungs-failed with attempts otherwise', async () => {
    await expect(runChain('stt', [], async () => 'x', {}, testContext())).rejects.toMatchObject({ code: 'no-provider' });
    const failing = rung('free/a', 'free', {
      run: async () => {
        throw new Error('network down');
      },
    });
    const err = await runChain('stt', [failing], (r) => r.run(), {}, testContext()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'all-rungs-failed' });
    expect(attemptsOf(err)).toHaveLength(1);
  });
});
