import { Vid2ContextError } from '@vid2context/core';
import { templatePrompts } from './prompts.generated.ts';

/**
 * The prompt text of a template, written in src/templates/<id>.md and
 * embedded at build time by scripts/embed-templates.mjs (no filesystem read
 * at runtime, so this works on Workers and in the browser).
 */
export function templatePrompt(id: string): string {
  const text = templatePrompts[id];
  if (text === undefined) {
    throw new Vid2ContextError('not-found', `Template prompt "${id}" is not embedded.`, {
      hint: `Add src/templates/${id}.md and run node packages/insights/scripts/embed-templates.mjs.`,
    });
  }
  return text;
}
