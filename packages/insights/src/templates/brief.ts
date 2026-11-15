import { list, obj, SOURCES, str } from './cite.ts';
import { templatePrompt } from './prompt.ts';
import type { Template } from './types.ts';

export const brief: Template = {
  id: 'brief',
  title: 'Brief',
  description:
    'A cited research brief: what the videos say, where they agree, where they disagree, and what only one source claims.',
  topics: [],
  instructions: templatePrompt('brief'),
  schema: obj({
    title: str('A short title for the brief'),
    summary: str('Three to five sentences answering the question from the videos'),
    points: list(
      obj({
        topic: str('Short topic name'),
        statement: str('One claim in plain words'),
        sources: SOURCES,
      }),
      'Every claim the videos make that matters for the question',
    ),
  }),
};
