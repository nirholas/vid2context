import { list, obj, SOURCES, str } from './cite.ts';
import { templatePrompt } from './prompt.ts';
import type { Template } from './types.ts';

export const summary: Template = {
  id: 'summary',
  title: 'Summary',
  description: 'A short summary and the key points of the videos, each point cited.',
  topics: [],
  instructions: templatePrompt('summary'),
  schema: obj({
    summary: str('One paragraph'),
    keyPoints: list(obj({ point: str('One sentence'), sources: SOURCES })),
  }),
};
