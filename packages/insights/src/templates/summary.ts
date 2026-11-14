import { list, obj, SOURCES, str } from './cite.ts';
import type { Template } from './types.ts';

export const summary: Template = {
  id: 'summary',
  title: 'Summary',
  description: 'A short summary and the key points of the videos, each point cited.',
  topics: [],
  instructions: `## Summary

Summarize the videos.

- summary: one paragraph of three to six sentences.
- keyPoints: the five to twelve most important points, each one sentence, in the order the videos make them.`,
  schema: obj({
    summary: str('One paragraph'),
    keyPoints: list(obj({ point: str('One sentence'), sources: SOURCES })),
  }),
};
