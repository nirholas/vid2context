import { list, obj, SOURCES, str } from './cite.ts';
import { templatePrompt } from './prompt.ts';
import type { Template } from './types.ts';

export const tutorialSteps: Template = {
  id: 'tutorial-steps',
  title: 'Tutorial steps',
  description:
    'The steps a tutorial walks through, in order, with prerequisites and pitfalls, each cited to the moment it is shown.',
  topics: ['prerequisites', 'steps', 'pitfalls', 'result'],
  instructions: templatePrompt('tutorial-steps'),
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
