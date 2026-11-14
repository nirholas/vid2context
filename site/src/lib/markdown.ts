/**
 * Markdown to HTML for the docs: marked for parsing, shiki for code (dual
 * light and dark themes switched by CSS), GitHub-compatible heading ids so
 * anchors written for GitHub keep working, and a link hook that turns repo
 * paths into site URLs.
 */
import { Marked, type Token, type Tokens, TextRenderer } from 'marked';
import { bundledLanguages, createHighlighter } from 'shiki';

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

export interface Rendered {
  html: string;
  headings: Heading[];
  title: string;
  description: string;
}

const LANGS = [
  'bash',
  'shellsession',
  'json',
  'jsonc',
  'typescript',
  'javascript',
  'tsx',
  'toml',
  'yaml',
  'markdown',
  'html',
  'css',
  'python',
  'dockerfile',
  'sql',
  'diff',
  'ini',
  'xml',
  'http',
  'powershell',
] as const;

const highlighter = await createHighlighter({ themes: ['github-dark-default', 'github-light-default'], langs: [...LANGS] });
const loaded = new Set<string>(highlighter.getLoadedLanguages());

const ALIASES: Record<string, string> = { sh: 'bash', shell: 'bash', zsh: 'bash', console: 'shellsession', ts: 'typescript', js: 'javascript', yml: 'yaml', md: 'markdown', py: 'python', env: 'ini', text: 'text', txt: 'text', srt: 'text', vtt: 'text' };

function langOf(info: string | undefined): string {
  const raw = (info ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const lang = ALIASES[raw] ?? raw;
  if (lang && loaded.has(lang)) return lang;
  if (lang && lang in bundledLanguages) return 'text';
  return 'text';
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** Highlighted code as HTML, the same markup the docs and the landing page use. */
export function highlight(code: string, lang: string): string {
  const html = highlighter.codeToHtml(code.replace(/\n$/, ''), {
    lang: langOf(lang),
    themes: { dark: 'github-dark-default', light: 'github-light-default' },
    defaultColor: false,
  });
  // A scrollable region must be reachable by keyboard (WCAG 2.1.1).
  return html.replace('<pre ', '<pre tabindex="0" ');
}

/** GitHub's heading slug: lowercase, punctuation dropped, spaces to hyphens, duplicates numbered. */
export class Slugger {
  private seen = new Map<string, number>();
  slug(text: string): string {
    const base = text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = this.seen.get(base);
    this.seen.set(base, (n ?? 0) + 1);
    return n === undefined ? base : `${base}-${n}`;
  }
}

function plainOf(tokens: Token[], parser: { parseInline(t: Token[], r?: TextRenderer): string }): string {
  return unescape(parser.parseInline(tokens, new TextRenderer()))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstParagraph(tokens: Token[]): string {
  for (const t of tokens) {
    if (t.type !== 'paragraph') continue;
    const p = t as Tokens.Paragraph;
    const text = p.text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 40) return text;
  }
  return '';
}

/** Cut at a word boundary to at most `max` characters. */
export function clip(text: string, max = 160): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,.;:]$/, '')}.`;
}

export interface RenderOptions {
  /** Rewrite a link or image href. Return undefined to keep it. */
  rewriteHref?: (href: string) => string | undefined;
}

export function renderMarkdown(source: string, opts: RenderOptions = {}): Rendered {
  const slugger = new Slugger();
  const headings: Heading[] = [];
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = plainOf(tokens, this.parser);
        const id = slugger.slug(text);
        headings.push({ depth, text, id });
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${id}">${inner}<a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a></h${depth}>\n`;
      },
      code({ text, lang }) {
        const label = escapeHtml((lang ?? '').split(/\s+/)[0] || 'text');
        const bar = `<div class="code-bar"><span class="code-label">${label}</span><button type="button" class="copy-btn" data-copy-btn>Copy</button></div>`;
        return `<div class="code">${bar}${highlight(text, lang ?? '')}</div>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        // `[Label](href "button")` renders as a one-click install button.
        if (title === 'button') return `<a class="btn btn-primary install-btn" href="${escapeHtml(href)}">${inner}</a>`;
        const external = /^https?:\/\//.test(href) && !href.startsWith('https://vid2context.com');
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        const rel = external ? ' rel="noopener"' : '';
        return `<a href="${escapeHtml(href)}"${t}${rel}>${inner}</a>`;
      },
      image({ href, title, text }) {
        // The site makes no third-party requests, so remote images (README badges) render as their alt text.
        if (/^(https?:)?\/\//.test(href)) return `<span class="img-alt">${escapeHtml(text)}</span>`;
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${t} loading="lazy" decoding="async">`;
      },
    },
  });
  const tokens = md.lexer(source);
  // marked runs walkTokens only inside parse(); lexer() plus parser() needs it called here.
  md.walkTokens(tokens, (token) => {
    if ((token.type === 'link' || token.type === 'image') && opts.rewriteHref) {
      const t = token as Tokens.Link | Tokens.Image;
      t.href = opts.rewriteHref(t.href) ?? t.href;
    }
  });
  const html = (md.parser(tokens) as string).replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  const title = headings.find((h) => h.depth === 1)?.text ?? '';
  return { html, headings, title, description: clip(firstParagraph(tokens)) };
}
