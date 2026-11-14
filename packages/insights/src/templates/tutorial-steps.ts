import { list, obj, SOURCES, str } from './cite.ts';
import type { Template } from './types.ts';

export const tutorialSteps: Template = {
  id: 'tutorial-steps',
  title: 'Tutorial steps',
  description:
    'The steps a tutorial walks through, in order, with prerequisites and pitfalls, each cited to the moment it is shown.',
  topics: ['prerequisites', 'steps', 'pitfalls', 'result'],
  instructions: `## Tutorial steps

Extract the procedure the videos teach.

- Prerequisites: tools, parts, accounts, software or skills needed before starting.
- Steps: every step in the order shown, one action per step, with the details needed to do it (values, settings, commands, part numbers) copied exactly.
- Pitfalls: mistakes, warnings and tips the presenter calls out.
- When several videos teach the same procedure differently, follow the order of the first video and note the differences in the step detail with both citations.`,
  schema: obj({
    goal: str('What following the steps achieves'),
    prerequisites: list(obj({ item: str('What is needed'), sources: SOURCES })),
    steps: list(
      obj({
        n: { type: 'integer', minimum: 1 },
        title: str('The step in a few words'),
        detail: str('How to do it, with exact values'),
        sources: SOURCES,
      }),
    ),
    pitfalls: list(obj({ warning: str('The mistake or tip'), sources: SOURCES })),
  }),
};
