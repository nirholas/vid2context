import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { briefInstructions, briefPrompt, buyerGuideInstructions, CITATION_RULE, extractPrompt } from '../src/index.ts';

const gwagon = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json'), 'utf8'),
) as VideoContext;
const zoo = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-jNQXAC9IVRw.json'), 'utf8'),
) as VideoContext;

/** Boundary tokens are random per call; replace them so snapshots are stable. */
const stable = (s: string) => s.replace(/(<<<(?:END_)?UNTRUSTED) [0-9a-f]{24}/g, '$1 <token>');

describe('briefPrompt', () => {
  const messages = briefPrompt([zoo], { question: 'What animals are shown?' });

  it('matches the snapshot', () => {
    expect(messages.map((m) => ({ ...m, content: stable(m.content) }))).toMatchSnapshot();
  });

  it('fences every transcript as untrusted data and tells the model so', () => {
    const [system, user] = messages;
    expect(system?.content).toContain('untrusted data');
    expect(user?.content).toMatch(/<<<UNTRUSTED [0-9a-f]{24} label="transcript" source="V1 youtube:jNQXAC9IVRw">>>/);
    expect(user?.content).toMatch(/<<<END_UNTRUSTED [0-9a-f]{24}>>>/);
  });

  it('states the citation rule with the timestamp link form', () => {
    const user = messages[1]?.content ?? '';
    expect(user).toContain(CITATION_RULE);
    expect(user).toContain('Timestamp link: https://www.youtube.com/watch?v=jNQXAC9IVRw&t=<seconds>s');
    expect(user).toContain('[0:01]');
  });

  it('lists sources that do not fit the budget instead of silently dropping them', () => {
    const m = briefPrompt([gwagon, zoo], { maxTokens: 1500, template: 'buyer-guide' });
    const user = m[1]?.content ?? '';
    expect(user).toContain('is cut at');
    expect(user).toContain('V2: youtube:jNQXAC9IVRw');
    expect(user).toContain('Known problems');
  });
});

describe('instructions for MCP prompts', () => {
  it('builds the buyer guide prompt text without sources', () => {
    const text = buyerGuideInstructions('Mercedes G-Wagon', 'Which year should I buy?');
    expect(text).toContain('Product: Mercedes G-Wagon');
    expect(text).toContain('Mileage');
    expect(text).toContain('consensus');
    expect(text).not.toContain('UNTRUSTED');
    expect(briefInstructions()).toContain(CITATION_RULE);
  });
});

describe('extractPrompt', () => {
  it('tags lines with whole seconds and includes the schema', () => {
    const m = extractPrompt([gwagon], { template: 'buyer-guide' });
    const user = m[1]?.content ?? '';
    expect(user).toContain("[0] so you're going to buy G wagon");
    expect(user).toContain('"knownProblems"');
  });
});
