import { describe, expect, it } from 'vitest';
import { ThinkSplitter } from '../src/stream.ts';

describe('ThinkSplitter', () => {
  it('routes <think> blocks to reasoning even when tags split across chunks', () => {
    const s = new ThinkSplitter();
    const chunks = ['<thi', 'nk>The user asks about Apollo.</th', 'ink>Apollo 11 landed', ' in 1969.<'];
    let answer = '';
    let reasoning = '';
    for (const c of chunks) {
      const p = s.push(c);
      answer += p.answer;
      reasoning += p.reasoning;
    }
    const end = s.end();
    expect(answer + end.answer).toBe('Apollo 11 landed in 1969.<');
    expect(reasoning + end.reasoning).toBe('The user asks about Apollo.');
  });

  it('passes text without tags straight through', () => {
    const s = new ThinkSplitter();
    expect(s.push('Apollo 11 landed on the moon in 1969.')).toEqual({ answer: 'Apollo 11 landed on the moon in 1969.', reasoning: '' });
  });
});
