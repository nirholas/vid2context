/**
 * Interactive widgets in the site's own Markdown pages. A fenced block whose
 * info string is `widget <id>` (and no body) becomes one:
 *
 *   ```widget embed-builder
 *   ```
 *
 * Each widget renders its static markup at build time (so the page reads well
 * before any script runs) and gives the Markdown twin plain text instead.
 * Docs.astro loads a widget's browser script only on pages that use it.
 */
import { embedBuilderWidget, embedComponentWidget, embedGalleryWidget } from './embed-render.ts';
import { playgroundWidget } from './playground-render.ts';

export interface Widget {
  /** Build-time HTML for the block. */
  html(): string;
  /** Markdown for the page's twin, where the widget cannot run. */
  twin(): string;
}

const WIDGETS: Record<string, Widget> = {
  'embed-builder': embedBuilderWidget,
  'embed-gallery': embedGalleryWidget,
  'embed-component': embedComponentWidget,
  playground: playgroundWidget,
};

export const WIDGET_IDS = Object.keys(WIDGETS);

export const WIDGET_FENCE = /^widget\s+([a-z0-9-]+)\s*$/;

function widget(id: string, where: string): Widget {
  const w = WIDGETS[id];
  if (!w) throw new Error(`Unknown widget "${id}" in ${where}. Known: ${WIDGET_IDS.join(', ')}.`);
  return w;
}

/** Ids of the `widget <id>` fences in Markdown, in order. Unknown ids fail the build. */
export function widgetFenceIds(md: string, where: string): string[] {
  const ids = [...md.matchAll(/^```widget\s+([a-z0-9-]+)\s*$/gm)].map((m) => m[1] as string);
  for (const id of ids) widget(id, where);
  return ids;
}

export function renderWidget(id: string, where: string): string {
  return widget(id, where).html();
}

export function expandWidgetFencesForTwin(md: string, where: string): string {
  return md.replace(/^```widget\s+([a-z0-9-]+)\s*\n```\s*$/gm, (_m, id: string) => widget(id, where).twin());
}
