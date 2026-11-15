import { list, obj, SOURCES, str } from './cite.ts';
import { templatePrompt } from './prompt.ts';
import type { Template } from './types.ts';

export const comparison: Template = {
  id: 'comparison',
  title: 'Comparison',
  description: 'A comparison table: the options as rows, the criteria as columns, every cell cited.',
  topics: ['options', 'criteria', 'verdict'],
  instructions: templatePrompt('comparison'),
  schema: obj(
    {
      subject: str('What is being compared'),
      columns: list(str('A criterion'), 'The criteria, in display order'),
      rows: list(
        obj({
          label: str('The option'),
          cells: list(obj({ column: str('One of the columns'), value: str('What the videos say'), sources: SOURCES })),
        }),
      ),
      verdict: list(obj({ statement: str('Which option suits whom'), sources: SOURCES })),
    },
    [],
  ),
};
