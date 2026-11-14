/**
 * Argument completion from the user's library: collection ids and names, and
 * saved video ids and titles. Case-insensitive prefix match, at most 20 values
 * (the MCP spec allows 100 per response; 20 keeps pickers readable).
 */
import type { Storage } from '@vid2context/core';
import { allSummaries } from './inputs.ts';

export const MAX_COMPLETIONS = 20;

const starts = (value: string, prefix: string): boolean => value.toLowerCase().startsWith(prefix);

/** Collection ids and names starting with `prefix`. Both are accepted wherever a collection is expected. */
export async function completeCollections(storage: Storage | null | undefined, prefix: string): Promise<string[]> {
  if (!storage) return [];
  const p = prefix.trim().toLowerCase();
  const out = new Set<string>();
  for (const c of await storage.listCollections()) {
    if (starts(c.id, p)) out.add(c.id);
    if (starts(c.name, p)) out.add(c.name);
    if (out.size >= MAX_COMPLETIONS) break;
  }
  return [...out].slice(0, MAX_COMPLETIONS);
}

/** Saved video ids (youtube:abc) and titles starting with `prefix`, newest first. */
export async function completeVideos(storage: Storage | null | undefined, prefix: string): Promise<string[]> {
  if (!storage) return [];
  const p = prefix.trim().toLowerCase();
  const out = new Set<string>();
  for (const s of await allSummaries(storage)) {
    if (starts(s.id, p)) out.add(s.id);
    if (starts(s.title, p)) out.add(s.title);
    if (out.size >= MAX_COMPLETIONS) break;
  }
  return [...out].slice(0, MAX_COMPLETIONS);
}

/** Complete the last item of a comma-separated list, keeping the items before it. */
export async function completeListItem(value: string, complete: (prefix: string) => Promise<string[]>): Promise<string[]> {
  const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf('\n'));
  const head = cut === -1 ? '' : `${value.slice(0, cut + 1)} `;
  const last = cut === -1 ? value : value.slice(cut + 1);
  return (await complete(last)).map((v) => `${head}${v}`);
}
