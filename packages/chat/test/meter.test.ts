import { describe, expect, it } from 'vitest';
import { attachedFromContext } from '../src/lib/backend.ts';
import { ANSWER_RESERVE, conversationTokens, formatTokens, readMeter, suggestLarger, WARN_AT } from '../src/lib/meter.ts';
import { toModelRows } from '../src/lib/models.ts';
import { contextTokens } from '../src/lib/sources.ts';
import type { ModelRow } from '../src/lib/types.ts';
import { serverModels, sharedContext } from './helpers.ts';

const long = sharedContext('cCPsdFdlshc');
const short = sharedContext('jNQXAC9IVRw');
const rows = toModelRows(serverModels(), 'server');
const ovh = rows.find((r) => r.id === 'llm/ovh/gpt-oss-120b') as ModelRow;

describe('token meter on the real context fixtures', () => {
  it('estimates the long video in the thousands and the short one under a hundred', () => {
    expect(contextTokens(long)).toBeGreaterThan(3000);
    expect(contextTokens(long)).toBeLessThan(8000);
    expect(contextTokens(short)).toBeLessThan(120);
  });

  it('adds attached context, the conversation and room for the answer', () => {
    const contexts = [attachedFromContext(long, 'input', long.metadata.ref.url), attachedFromContext(short, 'local')];
    const messages = [{ content: 'Which engine does the 2000 G500 have?' }];
    const r = readMeter(contexts, messages, ovh, rows);
    expect(r.contextTokens).toBe(contextTokens(long) + contextTokens(short));
    expect(r.conversationTokens).toBe(conversationTokens(messages));
    expect(r.used).toBe(r.contextTokens + r.conversationTokens + ANSWER_RESERVE);
    expect(r.limit).toBe(131_072);
    expect(r.level).toBe('ok');
  });

  it('warns near the limit and suggests the smallest larger window that is enabled', () => {
    const contexts = [attachedFromContext(long, 'input', 'x')];
    const tiny: ModelRow = { ...ovh, id: 'tiny', contextTokens: Math.ceil((contextTokens(long) + ANSWER_RESERVE) / 0.9) };
    const r = readMeter(contexts, [], tiny, [tiny, ...rows]);
    expect(r.level).toBe('warn');
    expect(r.ratio).toBeGreaterThanOrEqual(WARN_AT);
    const expected = suggestLarger(rows, r.used, tiny.contextTokens as number);
    expect(r.suggestion?.id).toBe(expected?.id);
    expect(r.suggestion?.enabled).toBe(true);
    expect((r.suggestion?.contextTokens ?? 0) * WARN_AT).toBeGreaterThanOrEqual(r.used);
  });

  it('flags overflow', () => {
    const contexts = [attachedFromContext(long, 'input', 'x')];
    const small: ModelRow = { ...ovh, id: 'small', contextTokens: 2048 };
    expect(readMeter(contexts, [], small, rows).level).toBe('over');
  });

  it('cannot judge a model without a declared window', () => {
    const { contextTokens: _drop, ...noWindow } = ovh;
    expect(readMeter([attachedFromContext(short, 'local')], [], noWindow as ModelRow, rows).level).toBe('unknown');
  });

  it('formats counts compactly', () => {
    expect(formatTokens(987)).toBe('987');
    expect(formatTokens(4520)).toBe('4.5K');
    expect(formatTokens(131_072)).toBe('131K');
    expect(formatTokens(1_048_576)).toBe('1M');
  });
});
