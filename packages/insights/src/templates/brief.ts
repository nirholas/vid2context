import { list, obj, SOURCES, str } from './cite.ts';
import type { Template } from './types.ts';

export const brief: Template = {
  id: 'brief',
  title: 'Brief',
  description: 'A cited research brief: what the videos say, where they agree, where they disagree, and what only one source claims.',
  topics: [],
  instructions: `## Brief

Write a research brief from the videos.

- Group findings by topic. Use short topic names (two to four words).
- Under each topic, put what two or more videos agree on first, then where they disagree (cite both sides), then claims only one video makes.
- Prefer concrete, checkable claims: numbers, names, years, prices, recommendations, warnings, verdicts.
- Do not add knowledge that is not in the videos. If the videos do not answer part of the question, say so.`,
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
