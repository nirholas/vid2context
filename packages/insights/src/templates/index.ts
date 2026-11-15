/**
 * Extraction and brief templates. The prompt text of each lives in
 * src/templates/<id>.md; scripts/embed-templates.mjs embeds those files into
 * prompts.generated.ts so the package runs unchanged on Workers and in the
 * browser (no filesystem read at runtime). The id, title, topics and JSON
 * Schema live in <id>.ts next to it.
 */
import { Vid2ContextError } from '@vid2context/core';
import { brief } from './brief.ts';
import { buyerGuide } from './buyer-guide.ts';
import { comparison } from './comparison.ts';
import { summary } from './summary.ts';
import { tutorialSteps } from './tutorial-steps.ts';
import type { Template } from './types.ts';

export { CITE_SCHEMA } from './cite.ts';
export { templatePrompt } from './prompt.ts';
export type { Template } from './types.ts';

export const templates: Record<string, Template> = {
  [brief.id]: brief,
  [buyerGuide.id]: buyerGuide,
  [tutorialSteps.id]: tutorialSteps,
  [comparison.id]: comparison,
  [summary.id]: summary,
};

export function getTemplate(id: string | undefined, fallback = 'brief'): Template {
  const key = (id ?? fallback).trim().toLowerCase().replace(/_/g, '-');
  const t = templates[key];
  if (!t) {
    throw new Vid2ContextError('bad-request', `Unknown template "${id}".`, {
      hint: `Use one of: ${Object.keys(templates).join(', ')}. For anything else pass a JSON Schema as "schema".`,
    });
  }
  return t;
}
