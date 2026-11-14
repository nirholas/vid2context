/**
 * Prompt biasing. Whisper treats the prompt as text that came before the
 * audio, so names and jargon in it get spelled the same way in the
 * transcript. The video's own metadata is the best free source of those
 * words. The pipeline (or a later integration) should call
 * `promptFromMetadata` and pass the result as `SttOptions.prompt`.
 */
import type { VideoMetadata } from '@vid2context/core';

export type PromptMetadata = Pick<VideoMetadata, 'title'> & Partial<Pick<VideoMetadata, 'channel' | 'chapters' | 'tags'>>;

function clean(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Build a recognition prompt from a video's title, channel name, chapter
 * titles and tags, in that order of importance, de-duplicated and cut at a
 * whole item so it never exceeds `maxChars`. Returns '' when there is nothing
 * useful. 800 characters stays inside Whisper's 224-token prompt window for
 * English text.
 */
export function promptFromMetadata(metadata: PromptMetadata, maxChars = 800): string {
  const seen = new Set<string>();
  const take = (items: (string | undefined)[]): string[] => {
    const out: string[] = [];
    for (const item of items) {
      const c = clean(item).replace(/[.,;:]+$/, '');
      const key = c.toLowerCase();
      if (!c || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  };
  const groups = [
    take([metadata.title]),
    take([metadata.channel?.name]),
    take((metadata.chapters ?? []).map((c) => c.title)),
    take(metadata.tags ?? []),
  ];
  let prompt = '';
  for (const group of groups) {
    let sentence = '';
    for (const item of group) {
      const next = sentence ? `${sentence}, ${item}` : item;
      const candidate = `${prompt}${prompt ? ' ' : ''}${next}.`;
      if (candidate.length > maxChars) break;
      sentence = next;
    }
    if (sentence) prompt = `${prompt}${prompt ? ' ' : ''}${sentence}.`;
  }
  return prompt;
}

/** Cut a prompt to `maxChars`, keeping the start (the title matters most) and ending on a word boundary. */
export function clampPrompt(prompt: string, maxChars: number): string {
  const p = clean(prompt);
  if (p.length <= maxChars) return p;
  const cut = p.slice(0, maxChars);
  const space = cut.lastIndexOf(' ');
  return (space > maxChars / 2 ? cut.slice(0, space) : cut).trim();
}
