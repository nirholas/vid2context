/**
 * A question about both ends of a real 18-minute transcript (the shared
 * fixture youtube-cCPsdFdlshc.json). Ollama's default window keeps only the
 * last ~2,000 prompt tokens, so a truncated prompt loses the host's
 * introduction at the start; a correct answer names him and the closing
 * recommendation.
 */
import { readFileSync } from 'node:fs';
import type { ChatRequest } from '@vid2context/core';

interface Ctx {
  transcript: { segments: { startSec: number; text: string }[] };
}

export function longTranscript(): string {
  const raw = readFileSync(new URL('../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as Ctx).transcript.segments.map((s) => s.text).join(' ');
}

export function longTranscriptRequest(): ChatRequest {
  return {
    messages: [
      { role: 'system', content: 'Answer only from the transcript. Be brief.' },
      {
        role: 'user',
        content:
          `Transcript:\n${longTranscript()}\n\n` +
          'Two questions. 1) What is the name of the host who introduces himself at the very start? ' +
          '2) At the very end, which G-Wagon do they recommend for the best economy value for the buck?',
      },
    ],
    maxTokens: 120,
    temperature: 0,
  };
}
