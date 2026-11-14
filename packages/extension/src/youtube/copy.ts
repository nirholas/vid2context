/**
 * The text behind "Copy for AI". The agent prompt from core (a citation
 * header plus the context pack within a token budget) by default, or any
 * formatter from the core `formatters` map, wrapped in the user's template.
 */
import { agentPrompt, formatters, render, type VideoContext } from '@vid2context/core';
import { AGENT_FORMAT, applyTemplate, type Settings } from '../lib/settings.ts';

export interface CopyResult {
  text: string;
  /** What produced the content: `agentPrompt` or a formatter id. */
  via: string;
}

/** Choices for the copy format: the agent prompt, then every formatter core knows, read at runtime. */
export function copyFormats(): { id: string; description: string }[] {
  return [
    { id: AGENT_FORMAT, description: 'Agent prompt: citation instructions plus the context pack, sized for a chat window.' },
    ...Object.values(formatters).map((f) => ({ id: f.id, description: f.description })),
  ];
}

export function templateVars(context: VideoContext, content: string): Record<string, string> {
  return {
    content,
    title: context.metadata.title,
    url: context.metadata.ref.url ?? context.metadata.ref.input,
    channel: context.metadata.channel?.name ?? '',
  };
}

export function renderForCopy(
  context: VideoContext,
  settings: Pick<Settings, 'copyFormat' | 'copyTemplate' | 'timestamps'>,
): CopyResult {
  const useFormatter = settings.copyFormat !== AGENT_FORMAT && formatters[settings.copyFormat];
  const content = useFormatter
    ? render(context, settings.copyFormat, { timestamps: settings.timestamps })
    : agentPrompt([context]);
  const via = useFormatter ? settings.copyFormat : 'agentPrompt';
  return { text: applyTemplate(settings.copyTemplate, templateVars(context, content)), via };
}
