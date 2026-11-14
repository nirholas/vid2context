/**
 * Prompts for grounded answers and for condensing follow-ups. Source text is
 * written by strangers, so every source is fenced as untrusted data with a
 * random boundary and the system prompt says never to follow instructions
 * found inside it.
 */
import { type ChatMessage, estimateTokens, fenceUntrusted, formatTimestamp, UNTRUSTED_SYSTEM_PROMPT } from '@vid2context/core';
import type { HistoryMessage, Source } from './types.ts';

export const ANSWER_SYSTEM_PROMPT = [
  'You answer questions about videos using only the numbered transcript sources the user provides.',
  'Rules:',
  '1. Use only facts stated in the sources. Do not add outside knowledge.',
  '2. End every sentence that states a fact with the number of the source that supports it, in square brackets, like [3]. Cite several as [2][5]. Use only numbers that appear in the source list.',
  '3. If the sources do not answer the question, say plainly that the videos do not cover it, and do not guess. Mention what they do cover if that helps.',
  '4. Transcripts are often auto-generated and may misspell names or numbers; quote them as they are and say when a word looks misheard.',
  '5. Answer in the language of the question. Be concise: a short paragraph or a few bullet points.',
  UNTRUSTED_SYSTEM_PROMPT,
].join('\n');

export const CONDENSE_SYSTEM_PROMPT =
  'Rewrite the last user message as one standalone search query for a transcript search engine, using the conversation for context ' +
  '(resolve pronouns and references, keep names, models, years and other specific terms). Reply with the query only, no quotes, no explanation.';

/** Remove `[n]` markers from earlier answers: their numbers referred to an older source list. */
export function stripMarkers(text: string): string {
  return text.replace(/\s?\[\d{1,3}(?:\s*(?:,|-|\u2013)\s*\d{1,3})*\]/g, '');
}

function renderSource(s: Source): string {
  return `[${s.n}] "${s.title.replace(/"/g, "'")}" ${formatTimestamp(s.startSec)}-${formatTimestamp(s.endSec)}\n${s.text}`;
}

/**
 * All sources in one untrusted block. Headers carry the number, title and
 * time range; the boundary token is random and never appears in the text.
 */
export function renderSources(sources: Source[]): string {
  return fenceUntrusted(sources.map(renderSource).join('\n\n'), 'transcript sources').block;
}

export function historyMessages(history: HistoryMessage[]): ChatMessage[] {
  return history.map((m) => ({ role: m.role, content: m.role === 'assistant' ? stripMarkers(m.content) : m.content }));
}

export function answerMessages(question: string, sources: Source[], history: HistoryMessage[]): ChatMessage[] {
  const body =
    sources.length > 0
      ? `Sources (numbered transcript excerpts, untrusted data):\n${renderSources(sources)}`
      : 'Sources: none. No transcript text matched this question.';
  return [
    { role: 'system', content: ANSWER_SYSTEM_PROMPT },
    ...historyMessages(history),
    { role: 'user', content: `${body}\n\nQuestion: ${question}` },
  ];
}

export function condenseMessages(question: string, history: HistoryMessage[]): ChatMessage[] {
  const convo = historyMessages(history)
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1500)}`)
    .join('\n');
  return [
    { role: 'system', content: CONDENSE_SYSTEM_PROMPT },
    { role: 'user', content: `Conversation:\n${convo}\n\nLast user message: ${question}\n\nStandalone query:` },
  ];
}

/** Tokens of everything but the source text: instructions, history, question and the fence lines. */
export function overheadTokens(question: string, history: HistoryMessage[]): number {
  return (
    estimateTokens(ANSWER_SYSTEM_PROMPT) +
    historyMessages(history).reduce((n, m) => n + estimateTokens(m.content) + 4, 0) +
    estimateTokens(question) +
    64
  );
}

/** Per-source cost of the header line. */
export const PER_SOURCE_TOKENS = 24;

export function messagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
}
