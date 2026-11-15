/**
 * Every page under /docs/: the repo's own Markdown (read at build time, never
 * copied into site/), one page per agent client generated from
 * src/data/agents.ts, and the site's how-to and comparison pages in
 * src/content/. Each page has an HTML URL and a Markdown twin for agents.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { clients } from '../data/agents.ts';
import { data, lastModOf, REPO_URL, SITE_URL } from '../data/site.ts';
import { withBase } from './base.ts';
import { type Heading, renderMarkdown } from './markdown.ts';
import { repoPath } from './paths.ts';
import { createRunnableRenderer, expandRunFencesForTwin, FIXTURE_DIR, RUN_FENCE, runFenceIds } from './runnable-render.ts';
import { expandTokens } from './tokens.ts';
import { expandWidgetFencesForTwin, renderWidget, WIDGET_FENCE, widgetFenceIds } from './widgets.ts';

export type Section =
  | 'start'
  | 'tutorials'
  | 'examples'
  | 'embed'
  | 'how-to'
  | 'clients'
  | 'guides'
  | 'deploy'
  | 'compare'
  | 'contracts';

export const SECTIONS: { id: Section; label: string }[] = [
  { id: 'start', label: 'Start here' },
  { id: 'tutorials', label: 'Tutorials' },
  { id: 'examples', label: 'Examples' },
  { id: 'embed', label: 'Embed' },
  { id: 'how-to', label: 'How to' },
  { id: 'clients', label: 'Agent clients' },
  { id: 'guides', label: 'Guides' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'compare', label: 'Compare' },
  { id: 'contracts', label: 'Contracts' },
];

export interface DocPage {
  /** Path under /docs/, '' for the docs home. */
  slug: string;
  url: string;
  twinUrl: string;
  section: Section;
  /** Sidebar label. */
  label: string;
  title: string;
  description: string;
  html: string;
  headings: Heading[];
  /** Clean Markdown for the twin, links absolute. */
  twin: string;
  /** Repo paths this page is built from, for lastmod. */
  sources: string[];
  lastmod: string;
  /** Where to edit the source on GitHub. */
  editUrl: string;
  order: number;
  /** How many runnable examples the page has (the browser script loads only when there are some). */
  runnables: number;
  /** Ids of the page's `widget <id>` blocks (each loads its browser script only where it is used). */
  widgets: string[];
}

/** `/docs/x/` to `/docs/x.md`; `/` to `/index.md`. */
export function twinOf(url: string): string {
  const trimmed = url.replace(/\/$/, '');
  return trimmed === '' ? '/index.md' : `${trimmed}.md`;
}

// ------------------------------------------------------------------ repo docs

interface RepoDoc {
  path: string;
  slug: string;
  section: Section;
  label?: string;
  order: number;
}

function repoDocs(): RepoDoc[] {
  const fixed: RepoDoc[] = [
    { path: 'README.md', slug: '', section: 'start', label: 'Overview', order: 0 },
    { path: 'docs/ARCHITECTURE.md', slug: 'architecture', section: 'start', label: 'Architecture', order: 1 },
    { path: 'docs/providers.md', slug: 'providers', section: 'start', label: 'Providers and rungs', order: 2 },
  ];
  // `readme` gives a directory's README.md its own slug and label; `offset` orders the pages after others in the section.
  const fromDir = (
    dir: string,
    section: Section,
    opts: { offset?: number; readme?: { slug: string; label: string } } = {},
  ): RepoDoc[] =>
    data.docSources
      .filter((p) => posix.dirname(p) === dir)
      .sort((a, b) => Number(posix.basename(b) === 'README.md') - Number(posix.basename(a) === 'README.md') || a.localeCompare(b))
      .map((p, n) => {
        const name = posix.basename(p, '.md');
        const readme = name === 'README' ? opts.readme : undefined;
        return {
          path: p,
          slug: readme ? readme.slug : `${dir.replace(/^docs\//, '')}/${name}`,
          section,
          ...(readme ? { label: readme.label } : {}),
          order: (opts.offset ?? 0) + n,
        };
      });
  return [
    ...fixed,
    // docs/examples: runnable scripts in examples/, after the site's own runnable example pages.
    ...fromDir('docs/examples', 'examples', { offset: 50, readme: { slug: 'examples/scripts', label: 'Example scripts' } }),
    ...fromDir('docs/guides', 'guides'),
    ...fromDir('docs/deploy', 'deploy'),
    ...fromDir('docs/contracts', 'contracts'),
  ];
}

const REPO_DOCS = repoDocs();
const URL_BY_REPO_PATH = new Map(REPO_DOCS.map((d) => [d.path, d.slug ? `/docs/${d.slug}/` : '/docs/']));

const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');

/**
 * Resolve a link written in a repo Markdown file. Docs that are on the site
 * become site URLs (HTML, or the .md twin), other repo files link to GitHub.
 */
function resolveRepoLink(href: string, fromPath: string, twin: boolean): string | undefined {
  if (!href || href.startsWith('#') || isExternal(href)) return undefined;
  if (href.startsWith('/')) return twin ? `${SITE_URL}${href}` : withBase(href);
  const [pathPart = '', hash] = href.split('#');
  const target = posix.normalize(posix.join(posix.dirname(fromPath), decodeURIComponent(pathPart)));
  const anchor = hash ? `#${hash}` : '';
  const site = URL_BY_REPO_PATH.get(target);
  if (site) return twin ? `${SITE_URL}${twinOf(site)}${anchor}` : withBase(`${site}${anchor}`);
  if (target.startsWith('..')) return undefined;
  const kind = existsSync(repoPath(target)) && statSync(repoPath(target)).isDirectory() ? 'tree' : 'blob';
  return `${REPO_URL}/${kind}/main/${target}${anchor}`;
}

function repoPage(doc: RepoDoc): DocPage {
  const source = readFileSync(repoPath(doc.path), 'utf8');
  const rendered = renderMarkdown(source, { rewriteHref: (h) => resolveRepoLink(h, doc.path, false) });
  const twin = renderTwin(source, (h) => resolveRepoLink(h, doc.path, true));
  const url = doc.slug ? `/docs/${doc.slug}/` : '/docs/';
  return {
    slug: doc.slug,
    url,
    twinUrl: twinOf(url),
    section: doc.section,
    label: doc.label ?? rendered.title ?? doc.slug,
    title: doc.slug === '' ? 'vid2context documentation' : rendered.title || doc.slug,
    description: rendered.description,
    html: rendered.html,
    headings: rendered.headings,
    twin,
    sources: [doc.path],
    lastmod: lastModOf([doc.path]),
    editUrl: `${REPO_URL}/blob/main/${doc.path}`,
    order: doc.order,
    runnables: 0,
    widgets: [],
  };
}

/** Rewrite the links of a Markdown source without touching anything else. */
function renderTwin(source: string, rewrite: (href: string) => string | undefined): string {
  return source.replace(/(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (m, open: string, href: string, close: string) => {
    if (open.startsWith('!')) return m;
    const next = rewrite(href);
    return next ? `${open}${next}${close}` : m;
  });
}

// ------------------------------------------------------------------ site-authored pages

interface Frontmatter {
  /** A generated-data key the page needs (for example `playlist`); the page is left out when it is missing. */
  requires?: string;
  title: string;
  label?: string;
  description: string;
  order: number;
}

function parseFrontmatter(text: string, file: string): { fm: Frontmatter; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m?.[1]) throw new Error(`${file} has no frontmatter.`);
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv?.[1]) fields[kv[1]] = (kv[2] ?? '').replace(/^"(.*)"$/, '$1');
  }
  if (!fields.title || !fields.description) throw new Error(`${file} needs a title and a description.`);
  return {
    fm: {
      requires: fields.requires,
      title: fields.title,
      label: fields.label,
      description: fields.description,
      order: Number(fields.order ?? 99),
    },
    body: m[2] ?? '',
  };
}

const CONTENT_SECTIONS: { dir: string; section: Section }[] = [
  { dir: 'tutorials', section: 'tutorials' },
  { dir: 'examples', section: 'examples' },
  { dir: 'embed', section: 'embed' },
  { dir: 'how-to', section: 'how-to' },
  { dir: 'compare', section: 'compare' },
];

/** Links in the site's own pages are site paths already; the twin gets absolute ones. */
function resolveSiteLink(href: string, twin: boolean): string | undefined {
  if (!href || href.startsWith('#') || isExternal(href)) return undefined;
  if (href.startsWith('/')) {
    if (!twin) return withBase(href);
    const [p = '', hash] = href.split('#');
    const isPage = p.endsWith('/') && (p.startsWith('/docs/') || p === '/');
    return `${SITE_URL}${isPage ? twinOf(p) : p}${hash ? `#${hash}` : ''}`;
  }
  return `${REPO_URL}/blob/main/${posix.normalize(href)}`;
}

interface Authored {
  file: string;
  rel: string;
  fm: Frontmatter;
  body: string;
  /** `index.md` is the section's landing page at /docs/<dir>/. */
  slug: string;
}

/** `{{pages:<dir>}}`: the other pages of a section as a list, in sidebar order. */
function pageList(entries: Authored[]): string {
  return entries
    .filter((e) => !e.file.startsWith('index.'))
    .map((e) => `- [${e.fm.title}](/docs/${e.slug}/): ${e.fm.description}`)
    .join('\n');
}

function authoredPage(section: Section, dir: string, entry: Authored, siblings: Authored[]): DocPage {
  const { rel, fm, body, slug } = entry;
  const withList = body.replace(/\{\{pages:([a-z-]+)\}\}/g, (_m, d: string) => {
    if (d !== dir) throw new Error(`{{pages:${d}}} in ${rel}: only {{pages:${dir}}} is known here.`);
    return pageList(siblings);
  });
  const expanded = `# ${fm.title}\n\n${expandTokens(withList, rel).trim()}\n`;
  const ids = runFenceIds(expanded);
  const widgets = widgetFenceIds(expanded, rel);
  const renderRun = createRunnableRenderer();
  const rendered = renderMarkdown(expanded, {
    rewriteHref: (h) => resolveSiteLink(h, false),
    renderCode: (lang) => {
      const m = lang.match(RUN_FENCE);
      if (m?.[1]) return renderRun(m[1]);
      const w = lang.match(WIDGET_FENCE);
      return w?.[1] ? renderWidget(w[1], rel) : undefined;
    },
  });
  const url = `/docs/${slug}/`;
  const runSources = ids.length ? ['site/src/data/runnables.ts', ...ids.map((id) => `${FIXTURE_DIR}/${id}.json`)] : [];
  return {
    slug,
    url,
    twinUrl: twinOf(url),
    section,
    label: fm.label ?? fm.title,
    title: fm.title,
    description: fm.description,
    html: rendered.html,
    headings: rendered.headings,
    twin: renderTwin(expandWidgetFencesForTwin(expandRunFencesForTwin(expanded), rel), (h) => resolveSiteLink(h, true)),
    sources: [rel, ...runSources, 'tests/fixtures/contexts', 'packages/discovery/src'],
    lastmod: lastModOf([rel, ...runSources]),
    editUrl: `${REPO_URL}/blob/main/${rel}`,
    order: fm.order,
    runnables: ids.length,
    widgets: [...new Set(widgets)],
  };
}

function authoredPages(): DocPage[] {
  return CONTENT_SECTIONS.flatMap(({ dir, section }) => {
    const abs = repoPath('site/src/content', dir);
    if (!existsSync(abs)) return [];
    const entries = readdirSync(abs)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((file): Authored | null => {
        const rel = `site/src/content/${dir}/${file}`;
        const { fm, body } = parseFrontmatter(readFileSync(repoPath(rel), 'utf8'), rel);
        if (fm.requires && !(data as unknown as Record<string, unknown>)[fm.requires]) return null;
        const slug = file === 'index.md' ? dir : `${dir}/${file.replace(/\.md$/, '')}`;
        return { file, rel, fm, body, slug };
      })
      .filter((e): e is Authored => e !== null)
      .sort((a, b) => a.fm.order - b.fm.order || a.fm.title.localeCompare(b.fm.title));
    return entries.map((e) => authoredPage(section, dir, e, entries));
  });
}

// ------------------------------------------------------------------ client pages

function clientPage(slug: string, order: number): DocPage {
  const c = clients.find((x) => x.slug === slug);
  if (!c) throw new Error(`Unknown client ${slug}`);
  const md = `# Use vid2context in ${c.name}

${c.name} can read any video through the vid2context MCP server: the transcript with timestamps, the metadata and the chapters. No key is needed. Captions come straight from the platform, and when a video has none, speech-to-text falls back through free and keyless Whisper rungs.

## Install

These steps use {{mcp.installMode}}.

{{client:${c.slug}}}

## Check that it works

${c.verify}

## Try it

Ask ${c.name}:

> Get the transcript of https://www.youtube.com/watch?v=jNQXAC9IVRw and summarize it with timestamps.

The \`get_transcript\` tool hands the agent a short header and the timed transcript. This is the real text it returns for "Me at the zoo", rendered by vid2context from a recorded run:

\`\`\`text
{{demo.mcpTranscript}}
\`\`\`

The agent can now cite moments by timestamp. For long videos it can call \`get_outline\` first and read only the sections it needs.

## Optional keys

Every key is optional. Each one unlocks more free rungs, which run before the keyless ones:

{{install.envVars}}

The full list, with every model override, is in [Providers and rungs](/docs/providers/).

## Links

- [${c.name} MCP documentation](${c.vendorDocs})
- [YouTube transcript MCP server](/docs/how-to/youtube-transcript-mcp-server/): what the tools do
- [Source on GitHub](${REPO_URL})
`;
  const rel = 'site/src/data/agents.ts';
  const expanded = expandTokens(md, `client page ${slug}`);
  const rendered = renderMarkdown(expanded, { rewriteHref: (h) => resolveSiteLink(h, false) });
  const url = `/docs/clients/${slug}/`;
  return {
    slug: `clients/${slug}`,
    url,
    twinUrl: twinOf(url),
    section: 'clients',
    label: c.name,
    title: `vid2context in ${c.name}: give it any video as context`,
    description: `Add the vid2context MCP server to ${c.name} so it can read YouTube and other videos as timed transcripts, metadata and chapters. Free, no key needed.`,
    html: rendered.html,
    headings: rendered.headings,
    twin: renderTwin(expanded, (h) => resolveSiteLink(h, true)),
    sources: [rel, 'packages/discovery/src', 'tests/fixtures/contexts'],
    lastmod: lastModOf([rel, 'packages/discovery/src', 'tests/fixtures/contexts']),
    editUrl: `${REPO_URL}/blob/main/${rel}`,
    order,
    runnables: 0,
    widgets: [],
  };
}

// ------------------------------------------------------------------ all

let pages: DocPage[] | undefined;

export function docPages(): DocPage[] {
  if (pages) return pages;
  const all = [...REPO_DOCS.map(repoPage), ...authoredPages(), ...clients.map((c, n) => clientPage(c.slug, n))];
  const order = new Map(SECTIONS.map((s, n) => [s.id, n]));
  all.sort(
    (a, b) => (order.get(a.section) ?? 0) - (order.get(b.section) ?? 0) || a.order - b.order || a.label.localeCompare(b.label),
  );
  pages = all;
  return all;
}

export function docBySlug(slug: string): DocPage {
  const p = docPages().find((d) => d.slug === slug);
  if (!p) throw new Error(`No docs page ${slug}`);
  return p;
}

export function sectionLabel(id: Section): string {
  return SECTIONS.find((s) => s.id === id)?.label ?? id;
}
