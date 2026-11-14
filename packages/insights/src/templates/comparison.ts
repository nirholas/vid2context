import { list, obj, SOURCES, str } from './cite.ts';
import type { Template } from './types.ts';

export const comparison: Template = {
  id: 'comparison',
  title: 'Comparison',
  description: 'A comparison table: the options as rows, the criteria as columns, every cell cited.',
  topics: ['options', 'criteria', 'verdict'],
  instructions: `## Comparison

Build a comparison table from the videos.

- Rows are the options compared (models, years, products, approaches).
- Columns are the criteria the videos actually use (price, reliability, power, comfort, ...). Use the same column names in every row.
- Each cell holds what the videos say for that option and criterion, with its citation. Leave a cell out when no video covers it.
- Verdict: which option the videos favour for which buyer, cited.`,
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
